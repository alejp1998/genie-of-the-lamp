import type { ChatMessage, Usage } from '../providers/types.ts';

export type Visibility = 'private' | 'project';

export interface Session {
  id: string;
  projectId: string;
  ownerId: string;
  ownerName: string;
  title: string;
  visibility: Visibility;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage extends ChatMessage {
  id: number;
  sessionId: string;
  runId: string | null;
  createdAt: string;
}

export type RunStatus = 'running' | 'done' | 'error' | 'cancelled' | 'limit';

export interface Run {
  id: string;
  sessionId: string;
  userId: string;
  status: RunStatus;
  provider: string;
  model: string;
  startedAt: string;
  finishedAt: string | null;
  usage: Usage | null;
  error: string | null;
}

export interface RunEvent {
  id: number;
  runId: string;
  type: string;
  data: unknown;
  createdAt: string;
}

export interface AuditEntry {
  userId: string;
  projectId: string;
  sessionId?: string | null;
  runId?: string | null;
  action: string;
  tool?: string | null;
  argsHash?: string | null;
  status: 'ok' | 'error' | 'denied' | 'cancelled';
  durationMs?: number | null;
  detail?: unknown;
}

export interface AuditRecord extends AuditEntry {
  id: number;
  at: string;
}

export interface Store {
  createSession(s: Omit<Session, 'createdAt' | 'updatedAt'>): Session;
  getSession(id: string): Session | null;
  /** The caller's own sessions plus project-shared ones, newest first. */
  listSessions(projectId: string, userId: string): Session[];
  updateSession(id: string, patch: Partial<Pick<Session, 'title' | 'visibility'>>): Session | null;
  touchSession(id: string): void;
  deleteSession(id: string): void;

  appendMessage(sessionId: string, runId: string | null, msg: ChatMessage): StoredMessage;
  listMessages(sessionId: string): StoredMessage[];

  createRun(r: Omit<Run, 'startedAt' | 'finishedAt' | 'usage' | 'error' | 'status'>): Run;
  finishRun(id: string, status: RunStatus, usage: Usage | null, error: string | null): void;
  getRun(id: string): Run | null;
  activeRun(sessionId: string): Run | null;
  listRuns(sessionId: string): Run[];
  /** Runs left 'running' by a crash or restart can never finish; mark them on boot. */
  failOrphanedRuns(): number;

  appendEvent(runId: string, type: string, data: unknown): RunEvent;
  listEvents(runId: string, afterId?: number): RunEvent[];
  /** Tool activity, notices and errors across a session's runs (no text deltas), for rendering history. */
  listSessionActivity(sessionId: string): RunEvent[];

  audit(e: AuditEntry): void;
  listAudit(filter: { projectId?: string; sessionId?: string; limit?: number }): AuditRecord[];

  close(): void;
}
