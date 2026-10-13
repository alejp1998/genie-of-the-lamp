/**
 * Provider-neutral conversation model. Sessions store these blocks; each
 * adapter translates them to its wire format. History is append-only: some
 * providers (Anthropic) bind reasoning blocks to the exact prior transcript,
 * so earlier turns are never rewritten.
 */

export type Block =
  /**
   * `meta: 'context'` marks gateway-written blocks (editor context, decision
   * notes): sent to the model, hidden in the chat. `meta: 'attachment'` is a
   * file or pasted text the user attached; the chat shows it as a chip.
   */
  | { type: 'text'; text: string; meta?: 'context' | 'attachment'; attachment?: { kind: 'file' | 'text'; name: string; path?: string }; note?: 'continue' }
  /** A pasted or attached image (base64), only ever in user turns. */
  | { type: 'image'; mediaType: string; data: string; name?: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  /** `images`: what a tool showed the model (view_image), sent alongside its text. */
  | { type: 'tool_result'; id: string; content: string; isError?: boolean; images?: { mediaType: string; data: string }[] }
  /** An attached PDF. Models that read PDFs get the file; the rest get `text`, extracted in the browser. */
  | { type: 'document'; mediaType: 'application/pdf'; data: string; name?: string; text?: string }
  /** Provider-specific block (e.g. Anthropic thinking with its signature),
   *  replayed verbatim only to the provider + model that produced it. */
  | { type: 'opaque'; provider: string; model: string; data: unknown };

export interface ChatMessage {
  role: 'user' | 'assistant';
  blocks: Block[];
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (object). */
  inputSchema: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal';

export interface TurnRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens: number;
  effort?: string;
  signal: AbortSignal;
}

export interface TurnCallbacks {
  onText(delta: string): void;
}

export interface TurnResult {
  blocks: Block[];
  stopReason: StopReason;
  usage: Usage;
  /** Provider's explanation when stopReason is 'refusal'. */
  detail?: string;
}

export interface Provider {
  readonly id: string;
  turn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult>;
}

/** A provider failure the user should see in plain words; `retryable` marks rate limits and 5xx. */
export class ProviderError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = retryable;
  }
}
