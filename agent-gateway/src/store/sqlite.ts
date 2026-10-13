import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ChatMessage, Usage } from '../providers/types.ts';
import type { AuditEntry, AuditRecord, Run, RunEvent, RunStatus, Session, Store, StoredMessage } from './types.ts';

const now = () => new Date().toISOString();

const CHAT_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  title TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'project')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions (project_id, updated_at);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  run_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  blocks TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session ON messages (session_id, id);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  usage TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS runs_session ON runs (session_id, started_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events (run_id, id);
`;

// Kept in its own file: audit records outlive deleted sessions and never hold chat content.
const AUDIT_SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  session_id TEXT,
  run_id TEXT,
  action TEXT NOT NULL,
  tool TEXT,
  args_hash TEXT,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_project ON audit (project_id, id);
CREATE INDEX IF NOT EXISTS audit_session ON audit (session_id, id);
`;

type Row = Record<string, any>;

const toSession = (r: Row): Session => ({
  id: r.id, projectId: r.project_id, ownerId: r.owner_id, ownerName: r.owner_name,
  title: r.title, visibility: r.visibility, createdAt: r.created_at, updatedAt: r.updated_at,
});

const toRun = (r: Row): Run => ({
  id: r.id, sessionId: r.session_id, userId: r.user_id, status: r.status, provider: r.provider, model: r.model,
  startedAt: r.started_at, finishedAt: r.finished_at ?? null, usage: r.usage ? JSON.parse(r.usage) : null, error: r.error ?? null,
});

export class SqliteStore implements Store {
  private db: DatabaseSync;
  private auditDb: DatabaseSync;

  /** `dir` = ':memory:' for tests. */
  constructor(dir: string) {
    if (dir === ':memory:') {
      this.db = new DatabaseSync(':memory:');
      this.auditDb = new DatabaseSync(':memory:');
    } else {
      fs.mkdirSync(dir, { recursive: true });
      this.db = new DatabaseSync(path.join(dir, 'gateway.db'));
      this.auditDb = new DatabaseSync(path.join(dir, 'audit.db'));
    }
    this.db.exec(CHAT_SCHEMA);
    this.auditDb.exec(AUDIT_SCHEMA);
  }

  createSession(s: Omit<Session, 'createdAt' | 'updatedAt'>): Session {
    const t = now();
    this.db.prepare(`INSERT INTO sessions (id, project_id, owner_id, owner_name, title, visibility, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(s.id, s.projectId, s.ownerId, s.ownerName, s.title, s.visibility, t, t);
    return { ...s, createdAt: t, updatedAt: t };
  }

  getSession(id: string): Session | null {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
    return r ? toSession(r) : null;
  }

  listSessions(projectId: string, userId: string): Session[] {
    return (this.db.prepare(`SELECT * FROM sessions WHERE project_id = ? AND (owner_id = ? OR visibility = 'project')
      ORDER BY updated_at DESC LIMIT 200`).all(projectId, userId) as Row[]).map(toSession);
  }

  updateSession(id: string, patch: Partial<Pick<Session, 'title' | 'visibility'>>): Session | null {
    const cur = this.getSession(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, updatedAt: now() };
    this.db.prepare('UPDATE sessions SET title = ?, visibility = ?, updated_at = ? WHERE id = ?').run(next.title, next.visibility, next.updatedAt, id);
    return next;
  }

  touchSession(id: string): void {
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now(), id);
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  appendMessage(sessionId: string, runId: string | null, msg: ChatMessage): StoredMessage {
    const t = now();
    const res = this.db.prepare('INSERT INTO messages (session_id, run_id, role, blocks, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, runId, msg.role, JSON.stringify(msg.blocks), t);
    return { id: Number(res.lastInsertRowid), sessionId, runId, role: msg.role, blocks: msg.blocks, createdAt: t };
  }

  listMessages(sessionId: string): StoredMessage[] {
    return (this.db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id').all(sessionId) as Row[]).map((r) => ({
      id: r.id, sessionId: r.session_id, runId: r.run_id ?? null, role: r.role, blocks: JSON.parse(r.blocks), createdAt: r.created_at,
    }));
  }

  createRun(r: Omit<Run, 'startedAt' | 'finishedAt' | 'usage' | 'error' | 'status'>): Run {
    const t = now();
    this.db.prepare(`INSERT INTO runs (id, session_id, user_id, status, provider, model, started_at) VALUES (?, ?, ?, 'running', ?, ?, ?)`)
      .run(r.id, r.sessionId, r.userId, r.provider, r.model, t);
    return { ...r, status: 'running', startedAt: t, finishedAt: null, usage: null, error: null };
  }

  finishRun(id: string, status: RunStatus, usage: Usage | null, error: string | null): void {
    this.db.prepare('UPDATE runs SET status = ?, finished_at = ?, usage = ?, error = ? WHERE id = ?')
      .run(status, now(), usage ? JSON.stringify(usage) : null, error, id);
  }

  getRun(id: string): Run | null {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return r ? toRun(r) : null;
  }

  activeRun(sessionId: string): Run | null {
    const r = this.db.prepare(`SELECT * FROM runs WHERE session_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1`).get(sessionId) as Row | undefined;
    return r ? toRun(r) : null;
  }

  listRuns(sessionId: string): Run[] {
    return (this.db.prepare('SELECT * FROM runs WHERE session_id = ? ORDER BY started_at').all(sessionId) as Row[]).map(toRun);
  }

  failOrphanedRuns(): number {
    const res = this.db.prepare(`UPDATE runs SET status = 'error', finished_at = ?, error = 'The gateway restarted while this run was in progress' WHERE status = 'running'`).run(now());
    return Number(res.changes);
  }

  appendEvent(runId: string, type: string, data: unknown): RunEvent {
    const t = now();
    const res = this.db.prepare('INSERT INTO events (run_id, type, data, created_at) VALUES (?, ?, ?, ?)').run(runId, type, JSON.stringify(data ?? null), t);
    return { id: Number(res.lastInsertRowid), runId, type, data, createdAt: t };
  }

  listEvents(runId: string, afterId = 0): RunEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id').all(runId, afterId) as Row[]).map((r) => ({
      id: r.id, runId: r.run_id, type: r.type, data: JSON.parse(r.data), createdAt: r.created_at,
    }));
  }

  audit(e: AuditEntry): void {
    this.auditDb.prepare(`INSERT INTO audit (at, user_id, project_id, session_id, run_id, action, tool, args_hash, status, duration_ms, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      now(), e.userId, e.projectId, e.sessionId ?? null, e.runId ?? null, e.action, e.tool ?? null, e.argsHash ?? null,
      e.status, e.durationMs ?? null, e.detail === undefined ? null : JSON.stringify(e.detail),
    );
  }

  listAudit(filter: { projectId?: string; sessionId?: string; limit?: number }): AuditRecord[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.projectId) { where.push('project_id = ?'); args.push(filter.projectId); }
    if (filter.sessionId) { where.push('session_id = ?'); args.push(filter.sessionId); }
    args.push(Math.min(filter.limit ?? 200, 1000));
    const rows = this.auditDb.prepare(`SELECT * FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...args) as Row[];
    return rows.map((r) => ({
      id: r.id, at: r.at, userId: r.user_id, projectId: r.project_id, sessionId: r.session_id, runId: r.run_id,
      action: r.action, tool: r.tool, argsHash: r.args_hash, status: r.status, durationMs: r.duration_ms,
      detail: r.detail ? JSON.parse(r.detail) : undefined,
    }));
  }

  close(): void {
    this.db.close();
    this.auditDb.close();
  }
}
