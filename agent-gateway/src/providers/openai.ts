import { abortError } from './anthropic.ts';
import { type Block, type ChatMessage, type Provider, ProviderError, type StopReason, type TurnCallbacks, type TurnRequest, type TurnResult } from './types.ts';

/** Chat Completions message shapes (the subset this adapter sends). */
type OAPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type OAMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OAPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export function toOpenAIMessages(system: string, messages: ChatMessage[], vision = false): OAMessage[] {
  const out: OAMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      const calls = m.blocks.flatMap((b) => (b.type === 'tool_call'
        ? [{ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }]
        : []));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Tool results must directly follow the assistant tool_calls; any user text comes after them.
    for (const b of m.blocks) {
      if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.id, content: b.isError ? `ERROR: ${b.content}` : b.content });
    }
    const text = m.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n\n');
    const images = m.blocks.filter((b): b is Extract<Block, { type: 'image' }> => b.type === 'image');
    if (images.length && vision) {
      out.push({ role: 'user', content: [...(text ? [{ type: 'text' as const, text }] : []), ...images.map((im) => ({ type: 'image_url' as const, image_url: { url: `data:${im.mediaType};base64,${im.data}` } }))] });
    } else {
      const note = images.map((im) => `[Image ${im.name ? `“${im.name}” ` : ''}attached; this model cannot view images.]`).join('\n');
      const all = [text, note].filter(Boolean).join('\n\n');
      if (all) out.push({ role: 'user', content: all });
    }
  }
  return out;
}

interface PartialCall { id: string; name: string; args: string }

function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return { __invalid_json: raw }; }
}

function mapFinish(reason: string | null | undefined, hasCalls: boolean): StopReason {
  if (hasCalls) return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'content_filter') return 'refusal';
  return 'end';
}

/** Any OpenAI-compatible Chat Completions endpoint: OpenAI, OpenRouter, vLLM, llama.cpp, Ollama. */
export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  private baseUrl: string;
  private apiKey?: string;
  private vision: boolean;

  constructor(id: string, baseUrl: string, apiKey?: string, vision = false) {
    this.id = id;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.vision = vision;
  }

  async turn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult> {
    const body = {
      model: req.model,
      messages: toOpenAIMessages(req.system, req.messages, this.vision),
      tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
      max_tokens: req.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      if (req.signal.aborted) throw abortError();
      throw new ProviderError(`Could not reach the model endpoint (${(err as Error).message}).`, true);
    }
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new ProviderError(`The model endpoint answered ${res.status}${detail ? `: ${detail}` : ''}`, res.status === 429 || res.status >= 500);
    }

    let text = '';
    let finish: string | null = null;
    const calls = new Map<number, PartialCall>();
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let evt: any;
          try { evt = JSON.parse(data); } catch { continue; }
          if (evt.usage) {
            usage.inputTokens = evt.usage.prompt_tokens ?? usage.inputTokens;
            usage.outputTokens = evt.usage.completion_tokens ?? usage.outputTokens;
            usage.cacheReadTokens = evt.usage.prompt_tokens_details?.cached_tokens ?? usage.cacheReadTokens;
          }
          const choice = evt.choices?.[0];
          if (!choice) continue;
          const d = choice.delta ?? {};
          if (typeof d.content === 'string' && d.content) {
            text += d.content;
            cb.onText(d.content);
          }
          for (const tc of d.tool_calls ?? []) {
            const idx = typeof tc.index === 'number' ? tc.index : calls.size;
            const cur = calls.get(idx) ?? { id: '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            calls.set(idx, cur);
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      }
    } catch (err) {
      if (req.signal.aborted) throw abortError();
      throw new ProviderError(`The model stream broke off (${(err as Error).message}).`, true);
    }

    const blocks: Block[] = [];
    if (text) blocks.push({ type: 'text', text });
    let n = 0;
    for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!c.name) continue;
      blocks.push({ type: 'tool_call', id: c.id || `call_${Date.now().toString(36)}_${n++}`, name: c.name, input: parseArgs(c.args) });
    }
    return { blocks, stopReason: mapFinish(finish, blocks.some((b) => b.type === 'tool_call')), usage };
  }
}
