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

/** `superseded`: the assistant proposed a newer version for the same file before the user decided. */
export type ProposalStatus = 'pending' | 'applying' | 'applied' | 'rejected' | 'stale' | 'failed' | 'superseded';

export interface ProposalChange {
  path: string;
  kind: 'edit' | 'create';
  edits?: { quote: string; replacement: string; occurrence?: number }[];
  content?: string;
}

export interface CompileOutcome {
  ok: boolean;
  errorsTotal: number;
  errors: { file: string | null; line: number | null; message: string }[];
  timedOut?: boolean;
}

export interface Proposal {
  id: string;
  sessionId: string;
  runId: string;
  /** The model's tool call that produced it; the panel draws the card in its place. */
  toolCallId: string;
  projectId: string;
  branch: string;
  status: ProposalStatus;
  summary: string;
  changes: ProposalChange[];
  /** Unified diff (multi-file, `diff --git` headers) of what Accept would write. */
  diff: string;
  added: number;
  removed: number;
  /** Git head and per-file versions when the proposal was made. */
  base: { head: string | null; versions: Record<string, { contentVersion: number; fileVersion: number }> };
  provider: string;
  model: string;
  createdAt: string;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  commit: string | null;
  /** Commit author Aldine recorded, e.g. "Ale (via Paper Assistant)". */
  author: string | null;
  edited: boolean;
  reason: string | null;
  compile: CompileOutcome | null;
  /** Whether the model has been told the decision (at the start of its next run). */
  noted: boolean;
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
  getMessage(id: number): StoredMessage | null;

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

  createProposal(p: Omit<Proposal, 'createdAt' | 'decidedBy' | 'decidedByName' | 'decidedAt' | 'commit' | 'author' | 'edited' | 'reason' | 'compile' | 'noted' | 'status'>): Proposal;
  getProposal(id: string): Proposal | null;
  listProposals(sessionId: string): Proposal[];
  updateProposal(id: string, patch: Partial<Omit<Proposal, 'id' | 'sessionId' | 'runId' | 'projectId'>>): Proposal | null;
  /** Decided proposals the model has not been told about yet. */
  unnotedDecisions(sessionId: string): Proposal[];
  /** Proposals still awaiting review count against new runs of the same session. */
  countPending(sessionId: string): number;

  audit(e: AuditEntry): void;
  listAudit(filter: { projectId?: string; sessionId?: string; limit?: number }): AuditRecord[];

  close(): void;
}
