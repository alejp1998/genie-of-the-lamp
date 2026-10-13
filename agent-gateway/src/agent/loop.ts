import crypto from 'node:crypto';
import { AldineToolError } from '../aldine/types.ts';
import type { Limits } from '../config.ts';
import { addUsage, type Block, type ChatMessage, emptyUsage, type Provider, type Usage } from '../providers/types.ts';
import type { AuditEntry, RunStatus } from '../store/types.ts';
import { type AgentTool, type ToolContext, toolSpecs } from './tools.ts';

export type Emit = (type: string, data: unknown) => void;

export interface LoopDeps {
  provider: Provider;
  model: string;
  effort?: string;
  system: string;
  tools: AgentTool[];
  toolCtx: ToolContext;
  limits: Limits;
  /** Full session history, ending with the new user message (already persisted). */
  history: ChatMessage[];
  persist(msg: ChatMessage): void;
  emit: Emit;
  audit(e: Omit<AuditEntry, 'userId' | 'projectId' | 'sessionId' | 'runId'>): void;
  signal: AbortSignal;
}

export interface LoopResult {
  status: RunStatus;
  usage: Usage;
  error?: string;
}

const argsHash = (input: unknown) => crypto.createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex').slice(0, 16);

export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} characters; narrow the request to see more]`;
}

/**
 * Adjacent same-role messages (e.g. a new question after a cancelled run)
 * merge into one turn, which every provider accepts. Order within is kept,
 * so tool results still precede the text that follows them.
 */
export function normalizeHistory(history: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of history) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.blocks = [...prev.blocks, ...m.blocks];
    else out.push({ role: m.role, blocks: [...m.blocks] });
  }
  return out;
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof Error && err.name === 'AbortError');
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms); });
  try { return await Promise.race([p, t]); } finally { clearTimeout(timer); }
}

async function executeCall(call: Extract<Block, { type: 'tool_call' }>, d: LoopDeps, byName: Map<string, AgentTool>): Promise<Block> {
  const tool = byName.get(call.name);
  const fail = (content: string): Block => ({ type: 'tool_result', id: call.id, content, isError: true });
  if (!tool) {
    d.audit({ action: 'tool_call', tool: call.name, argsHash: argsHash(call.input), status: 'denied', detail: { reason: 'unknown tool' } });
    return fail(`There is no tool named "${call.name}". Available: ${[...byName.keys()].join(', ')}.`);
  }
  const parsed = tool.schema.safeParse(call.input);
  if (!parsed.success) {
    d.audit({ action: 'tool_call', tool: tool.name, argsHash: argsHash(call.input), status: 'denied', detail: { reason: 'invalid input' } });
    return fail(`Invalid input for ${tool.name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`);
  }
  d.emit('tool_start', { id: call.id, name: tool.name, activity: tool.activity(parsed.data), input: parsed.data });
  const started = Date.now();
  try {
    if (d.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const result = await withTimeout(tool.run(parsed.data, d.toolCtx, { id: call.id }), d.limits.toolTimeoutMs, tool.name);
    const content = clip(JSON.stringify(result), d.limits.maxToolResultChars);
    const durationMs = Date.now() - started;
    d.emit('tool_end', { id: call.id, name: tool.name, ok: true, summary: tool.summarize(result), durationMs, output: clip(content, 4000) });
    d.audit({ action: 'tool_call', tool: tool.name, argsHash: argsHash(parsed.data), status: 'ok', durationMs });
    return { type: 'tool_result', id: call.id, content };
  } catch (err) {
    const durationMs = Date.now() - started;
    const cancelled = isAbort(err, d.signal);
    const message = cancelled ? 'Cancelled by the user before this tool finished.'
      : err instanceof AldineToolError ? err.message
        : `The tool failed: ${(err as Error).message}`;
    d.emit('tool_end', { id: call.id, name: tool.name, ok: false, summary: cancelled ? 'Cancelled' : message, durationMs });
    d.audit({ action: 'tool_call', tool: tool.name, argsHash: argsHash(parsed.data), status: cancelled ? 'cancelled' : 'error', durationMs, detail: cancelled ? undefined : { message: message.slice(0, 500) } });
    return fail(message);
  }
}

/** One user request: model turns and tool calls until the model answers, the user cancels, or a limit hits. */
export async function runLoop(d: LoopDeps): Promise<LoopResult> {
  const byName = new Map(d.tools.map((t) => [t.name, t]));
  const specs = toolSpecs(d.tools);
  const messages = [...d.history];
  let usage = emptyUsage();

  for (let iteration = 0; iteration < d.limits.maxIterations; iteration++) {
    let result;
    try {
      result = await d.provider.turn({
        model: d.model,
        system: d.system,
        messages: normalizeHistory(messages),
        tools: specs,
        maxTokens: d.limits.maxOutputTokens,
        effort: d.effort,
        signal: d.signal,
      }, { onText: (delta) => d.emit('text', { delta }) });
    } catch (err) {
      if (isAbort(err, d.signal)) return { status: 'cancelled', usage };
      throw err;
    }
    usage = addUsage(usage, result.usage);
    d.emit('usage', usage);

    const assistant: ChatMessage = { role: 'assistant', blocks: result.blocks };
    d.persist(assistant);
    messages.push(assistant);

    if (result.stopReason === 'refusal') {
      d.emit('notice', { level: 'warn', message: `The model declined to continue${result.detail ? `: ${result.detail}` : '.'}` });
      return { status: 'done', usage };
    }

    const calls = result.blocks.filter((b): b is Extract<Block, { type: 'tool_call' }> => b.type === 'tool_call');
    if (!calls.length) {
      if (result.stopReason === 'max_tokens') d.emit('notice', { level: 'warn', message: 'The reply hit the output limit and was cut off.' });
      return { status: 'done', usage };
    }

    let results: Block[];
    if (result.stopReason === 'max_tokens') {
      // Inputs cut off at the output limit may parse as valid but incomplete; never run them.
      results = calls.map((c) => ({ type: 'tool_result', id: c.id, isError: true, content: 'This tool call was cut off by the output limit and was not run. Retry with a smaller request.' }));
    } else {
      results = await Promise.all(calls.map((c) => executeCall(c, d, byName)));
    }
    const toolTurn: ChatMessage = { role: 'user', blocks: results };
    d.persist(toolTurn);
    messages.push(toolTurn);
    if (d.signal.aborted) return { status: 'cancelled', usage };
  }

  d.emit('notice', { level: 'warn', message: `Stopped after ${d.limits.maxIterations} steps. Ask a narrower question or continue from here.` });
  return { status: 'limit', usage };
}
