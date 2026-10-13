import { withBase } from '../basePath';

/** The Agent Gateway is mounted same-origin under this prefix; the session cookie travels with every call. */
export const GATEWAY = '/agent-gateway';

export type Block =
  | { type: 'text'; text: string; meta?: 'context' }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean }
  | { type: 'opaque' };

export interface ChatMessage {
  id: number;
  runId: string | null;
  role: 'user' | 'assistant';
  blocks: Block[];
  createdAt: string;
}

export interface AssistantSession {
  id: string;
  projectId: string;
  ownerId: string;
  ownerName: string;
  title: string;
  visibility: 'private' | 'project';
  createdAt: string;
  updatedAt: string;
  isOwner: boolean;
}

export interface RunInfo {
  id: string;
  status: 'running' | 'done' | 'error' | 'cancelled' | 'limit';
  provider: string;
  model: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface RunEvent {
  id: number;
  runId: string;
  type: string;
  data: any;
}

export interface SessionDetail {
  session: AssistantSession;
  messages: ChatMessage[];
  runs: RunInfo[];
  activity: RunEvent[];
  activeRunId: string | null;
}

export interface GatewayConfig {
  agentLabel: string;
  user: { id: string; name: string };
  authEnabled: boolean;
  models: { id: string; label: string; provider: string }[];
  defaultModel: string;
  limits: { maxMessageChars: number };
}

export interface EditorContext {
  branch: string;
  openFile?: string | null;
  cursor?: { line: number; column?: number } | null;
  selection?: { text: string; fromLine: number; toLine: number } | null;
}

export class GatewayError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== 'GET') headers.set('x-aladine-request', '1');
  if (init.body) headers.set('content-type', 'application/json');
  const res = await fetch(withBase(GATEWAY + path), { ...init, headers, credentials: 'same-origin' });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new GatewayError(body.error || `The assistant service answered ${res.status}`, res.status);
  return body as T;
}

export const gateway = {
  /** null when no gateway is deployed next to this Aldine: the assistant then stays out of the UI. */
  async probe(): Promise<GatewayConfig | null> {
    try {
      return await call<GatewayConfig>('/config');
    } catch {
      return null;
    }
  },
  sessions: (projectId: string) => call<{ sessions: AssistantSession[] }>(`/projects/${encodeURIComponent(projectId)}/sessions`),
  createSession: (projectId: string) => call<{ session: AssistantSession }>(`/projects/${encodeURIComponent(projectId)}/sessions`, { method: 'POST', body: '{}' }),
  session: (id: string) => call<SessionDetail>(`/sessions/${encodeURIComponent(id)}`),
  updateSession: (id: string, patch: { title?: string; visibility?: 'private' | 'project' }) =>
    call<{ session: AssistantSession }>(`/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteSession: (id: string) => call<void>(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  send: (id: string, text: string, context: EditorContext, model?: string) =>
    call<{ run: RunInfo }>(`/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ text, context, ...(model ? { model } : {}) }) }),
  cancel: (runId: string) => call<{ cancelled: boolean }>(`/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: '{}' }),
  /** EventSource reconnects on its own and resumes with Last-Event-ID. */
  events: (runId: string) => new EventSource(withBase(`${GATEWAY}/runs/${encodeURIComponent(runId)}/events`)),
};

export const RUN_EVENT_TYPES = ['status', 'text', 'tool_start', 'tool_end', 'usage', 'notice', 'error', 'done'] as const;
