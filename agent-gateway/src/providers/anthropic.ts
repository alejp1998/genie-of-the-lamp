import Anthropic from '@anthropic-ai/sdk';
import { type Block, type ChatMessage, type Provider, ProviderError, type StopReason, type TurnCallbacks, type TurnRequest, type TurnResult } from './types.ts';

const MAX_JSON_RETRIES = 2;

/** Neutral history → Anthropic messages. Reasoning blocks are replayed only to the model that wrote them. */
export function toAnthropicMessages(messages: ChatMessage[], model: string): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    const content: Anthropic.ContentBlockParam[] = [];
    for (const b of m.blocks) {
      if (b.type === 'text') {
        if (b.text) content.push({ type: 'text', text: b.text });
      } else if (b.type === 'tool_call' && m.role === 'assistant') {
        content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input as Record<string, unknown> });
      } else if (b.type === 'tool_result' && m.role === 'user') {
        content.push({ type: 'tool_result', tool_use_id: b.id, content: b.content, ...(b.isError ? { is_error: true } : {}) });
      } else if (b.type === 'opaque' && m.role === 'assistant' && b.provider === 'anthropic' && b.model === model) {
        content.push(b.data as Anthropic.ContentBlockParam);
      }
    }
    if (!content.length) content.push({ type: 'text', text: m.role === 'assistant' ? '(no reply)' : '(empty message)' });
    out.push({ role: m.role, content });
  }
  return out;
}

export function fromAnthropicContent(content: Anthropic.ContentBlock[], model: string): Block[] {
  const blocks: Block[] = [];
  for (const c of content) {
    if (c.type === 'text') blocks.push({ type: 'text', text: c.text });
    else if (c.type === 'tool_use') blocks.push({ type: 'tool_call', id: c.id, name: c.name, input: c.input });
    else if (c.type === 'thinking' || c.type === 'redacted_thinking') blocks.push({ type: 'opaque', provider: 'anthropic', model, data: c });
  }
  return blocks;
}

function mapStop(r: Anthropic.StopReason | null): StopReason {
  switch (r) {
    case 'tool_use': return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded': return 'max_tokens';
    case 'refusal': return 'refusal';
    default: return 'end';
  }
}

export class AnthropicProvider implements Provider {
  readonly id: string;
  private client: Anthropic;

  constructor(id: string, apiKey: string, baseURL?: string) {
    this.id = id;
    this.client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }

  async turn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult> {
    const tools: Anthropic.Tool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      // Inputs stream as generated; the loop validates every input against its schema before running it.
      eager_input_streaming: true,
    }));
    const params: Anthropic.MessageStreamParams = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      tools,
      messages: toAnthropicMessages(req.messages, req.model),
      thinking: { type: 'adaptive' },
      ...(req.effort ? { output_config: { effort: req.effort as Anthropic.OutputConfig['effort'] } } : {}),
      // Caches the stable prefix (tools, system, prior turns); per-turn editor context sits in the newest user message.
      cache_control: { type: 'ephemeral' },
    };

    for (let attempt = 0; ; attempt++) {
      const stream = this.client.messages.stream(params, { signal: req.signal });
      stream.on('text', (delta) => cb.onText(delta));
      let message: Anthropic.Message;
      try {
        message = await stream.finalMessage();
      } catch (err) {
        if (err instanceof Anthropic.APIUserAbortError || req.signal.aborted) throw abortError();
        if (err instanceof Anthropic.RateLimitError) throw new ProviderError('The model provider is rate-limiting requests. Try again in a minute.', true);
        if (err instanceof Anthropic.InternalServerError) throw new ProviderError('The model provider had a server error. Try again shortly.', true);
        if (err instanceof Anthropic.APIConnectionError) throw new ProviderError('Could not reach the model provider.', true);
        if (err instanceof Anthropic.AuthenticationError) throw new ProviderError('The configured Anthropic API key was rejected.');
        if (err instanceof Anthropic.APIError) throw new ProviderError(`The model provider refused the request: ${err.message}`);
        // A tool input that could not be parsed at all: re-issue the turn a bounded number of times.
        if (attempt < MAX_JSON_RETRIES) continue;
        throw new ProviderError('The model produced a tool call that could not be parsed.');
      }
      const u = message.usage;
      return {
        blocks: fromAnthropicContent(message.content, req.model),
        stopReason: mapStop(message.stop_reason),
        usage: {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        },
        ...(message.stop_reason === 'refusal' && message.stop_details?.explanation ? { detail: message.stop_details.explanation } : {}),
      };
    }
  }
}

export function abortError(): Error {
  const e = new Error('Run cancelled');
  e.name = 'AbortError';
  return e;
}
