import { abortError } from './anthropic.ts';
import { type Block, type ChatMessage, type Provider, type TurnCallbacks, type TurnRequest, type TurnResult } from './types.ts';

export interface MockTurn {
  text?: string;
  toolCalls?: { name: string; input: unknown }[];
}

export type MockScript = (messages: ChatMessage[]) => MockTurn;

/** `[[tool:name {json}]]` directives; the JSON may nest, so each candidate end is tried until one parses. */
export function parseDirectives(text: string): { name: string; input: unknown }[] {
  const out: { name: string; input: unknown }[] = [];
  const open = /\[\[tool:([a-z_]+)\s*/g;
  for (let m = open.exec(text); m; m = open.exec(text)) {
    const start = m.index + m[0].length;
    let input: unknown = {};
    let end = text.indexOf(']]', start);
    if (end < 0) break;
    if (text[start] === '{') {
      let parsed = false;
      for (let e = end; e >= 0; e = text.indexOf(']]', e + 1)) {
        try { input = JSON.parse(text.slice(start, e)); end = e; parsed = true; break; } catch { /* try the next ]] */ }
      }
      if (!parsed) input = { __invalid_json: text.slice(start, end) };
    }
    out.push({ name: m[1], input });
    open.lastIndex = end + 2;
  }
  return out;
}

/**
 * Default script, deterministic so e2e can drive it from the chat box:
 * `[[tool:read_file {"path":"main.tex"}]]` in a user message makes the next
 * turn call that tool; a turn that follows tool results summarises them.
 */
export const directiveScript: MockScript = (messages) => {
  const last = messages[messages.length - 1];
  if (!last) return { text: 'Hello.' };
  const results = last.blocks.filter((b) => b.type === 'tool_result');
  if (results.length) {
    const r = results[results.length - 1] as Extract<Block, { type: 'tool_result' }>;
    return { text: `${r.isError ? 'The tool failed' : 'Done'}: ${r.content.slice(0, 160)}` };
  }
  const text = last.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
  const calls = parseDirectives(text);
  if (calls.length) return { text: 'Working on it.', toolCalls: calls };
  const ask = text.replace(/<editor_context>[\s\S]*?<\/editor_context>/, '').trim();
  return { text: `Mock reply to: ${ask.slice(0, 200)}` };
};

/** Scripted provider: no network, no cost. Streams text in small chunks so the UI streaming path is exercised. */
export class MockProvider implements Provider {
  readonly id: string;
  private script: MockScript;
  private chunkDelayMs: number;
  private counter = 0;

  constructor(id = 'mock', script: MockScript = directiveScript, chunkDelayMs = 15) {
    this.id = id;
    this.script = script;
    this.chunkDelayMs = chunkDelayMs;
  }

  async turn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult> {
    const t = this.script(req.messages);
    const blocks: Block[] = [];
    if (t.text) {
      for (const piece of t.text.match(/.{1,12}/gs) ?? []) {
        if (req.signal.aborted) throw abortError();
        cb.onText(piece);
        if (this.chunkDelayMs) await new Promise((r) => setTimeout(r, this.chunkDelayMs));
      }
      blocks.push({ type: 'text', text: t.text });
    }
    for (const c of t.toolCalls ?? []) blocks.push({ type: 'tool_call', id: `mock_${++this.counter}`, name: c.name, input: c.input });
    if (req.signal.aborted) throw abortError();
    return {
      blocks,
      stopReason: t.toolCalls?.length ? 'tool_use' : 'end',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}
