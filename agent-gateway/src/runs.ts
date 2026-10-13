import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { buildContextBlock, type ClientContext } from './agent/context.ts';
import { runLoop } from './agent/loop.ts';
import { systemPrompt } from './agent/prompt.ts';
import { type AgentTool, ASSISTANT_TOOLS, newRunState } from './agent/tools.ts';
import { decisionsNote } from './patches/apply.ts';
import type { AldineApi, Identity, ProjectInfo } from './aldine/types.ts';
import type { Config, ModelRef } from './config.ts';
import type { ChatMessage, Provider } from './providers/types.ts';
import type { Run, RunEvent, Session, Store } from './store/types.ts';

const TEXT_FLUSH_MS = 60;
const TITLE_MAX = 60;

export class BusyError extends Error {}

interface LiveRun {
  controller: AbortController;
  bus: EventEmitter;
}

export interface StartRun {
  session: Session;
  identity: Identity;
  project: ProjectInfo;
  text: string;
  ctx: ClientContext;
  model: ModelRef;
}

export class RunManager {
  private live = new Map<string, LiveRun>();
  private store: Store;
  private aldine: AldineApi;
  private providers: Map<string, Provider>;
  private config: Config;
  private tools: AgentTool[];

  constructor(deps: { store: Store; aldine: AldineApi; providers: Map<string, Provider>; config: Config; tools?: AgentTool[] }) {
    this.store = deps.store;
    this.aldine = deps.aldine;
    this.providers = deps.providers;
    this.config = deps.config;
    this.tools = deps.tools ?? ASSISTANT_TOOLS;
  }

  isLive(runId: string): boolean { return this.live.has(runId); }

  /** Validates, then returns as soon as the run is recorded; the work continues in the background. */
  async start(req: StartRun): Promise<Run> {
    const { session, identity, project } = req;
    const active = this.store.activeRun(session.id);
    if (active && this.live.has(active.id)) throw new BusyError('The assistant is still answering in this session');
    const provider = this.providers.get(req.model.provider);
    if (!provider) throw new Error(`Provider "${req.model.provider}" is not configured`);
    // Minted up front so a credential failure is a clear error, not a failed run.
    const token = await this.aldine.credential(identity, project.id);

    const run = this.store.createRun({ id: crypto.randomUUID(), sessionId: session.id, userId: identity.user.id, provider: req.model.provider, model: req.model.model });
    const controller = new AbortController();
    const bus = new EventEmitter();
    bus.setMaxListeners(100);
    this.live.set(run.id, { controller, bus });

    if (session.title === 'New chat') {
      const title = req.text.replace(/\s+/g, ' ').trim();
      this.store.updateSession(session.id, { title: title.length > TITLE_MAX ? title.slice(0, TITLE_MAX - 1) + '…' : title || 'New chat' });
    } else this.store.touchSession(session.id);

    const auditBase = { userId: identity.user.id, projectId: project.id, sessionId: session.id, runId: run.id };
    this.store.audit({ ...auditBase, action: 'run_start', status: 'ok', detail: { provider: run.provider, model: run.model, branch: req.ctx.branch } });

    void this.execute(run, req, provider, token, controller, bus, auditBase);
    return run;
  }

  private async execute(
    run: Run, req: StartRun, provider: Provider, token: string, controller: AbortController, bus: EventEmitter,
    auditBase: { userId: string; projectId: string; sessionId: string; runId: string },
  ) {
    let pendingText = '';
    let flushTimer: NodeJS.Timeout | null = null;
    const publish = (type: string, data: unknown) => bus.emit('event', this.store.appendEvent(run.id, type, data));
    const flush = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (pendingText) { const delta = pendingText; pendingText = ''; publish('text', { delta }); }
    };
    // Text deltas coalesce into ~60 ms chunks: fewer rows and SSE frames, same visible streaming.
    const emit = (type: string, data: unknown) => {
      if (type === 'text') {
        pendingText += (data as { delta: string }).delta;
        if (!flushTimer) flushTimer = setTimeout(flush, TEXT_FLUSH_MS);
        return;
      }
      flush();
      publish(type, data);
    };
    const timeout = setTimeout(() => controller.abort(new Error('timeout')), this.config.limits.runTimeoutMs);

    let status: Run['status'] = 'error';
    let error: string | null = null;
    let usage = null;
    try {
      emit('status', { message: 'Gathering context…' });
      const contextBlock = await buildContextBlock({ aldine: this.aldine, token, project: req.project, ctx: req.ctx, signal: controller.signal });
      // Decisions on earlier proposals reach the model here, at the start of its next turn,
      // never mid-run where they would split a tool call from its result.
      const decided = this.store.unnotedDecisions(req.session.id);
      const note = decisionsNote(decided);
      for (const p of decided) this.store.updateProposal(p.id, { noted: true });
      const userMsg: ChatMessage = {
        role: 'user',
        blocks: [
          ...(note ? [{ type: 'text' as const, text: note, meta: 'context' as const }] : []),
          { type: 'text', text: contextBlock, meta: 'context' },
          { type: 'text', text: req.text },
        ],
      };
      this.store.appendMessage(req.session.id, run.id, userMsg);
      const history: ChatMessage[] = this.store.listMessages(req.session.id).map((m) => ({ role: m.role, blocks: m.blocks }));

      const result = await runLoop({
        provider,
        model: run.model,
        effort: run.provider === 'anthropic' ? this.config.effort : undefined,
        system: systemPrompt(this.config.agentLabel),
        tools: this.tools,
        toolCtx: {
          aldine: this.aldine, token, projectId: req.project.id, branch: req.ctx.branch, signal: controller.signal, limits: this.config.limits, state: newRunState(),
          propose: (draft) => {
            const p = this.store.createProposal({ ...draft, id: crypto.randomUUID(), sessionId: req.session.id, runId: run.id, projectId: req.project.id, branch: req.ctx.branch, provider: run.provider, model: run.model });
            this.store.audit({ ...auditBase, action: 'proposal_create', status: 'ok', detail: { proposal: p.id, files: p.changes.map((c) => c.path), added: p.added, removed: p.removed } });
            emit('proposal', p);
            return p;
          },
        },
        limits: this.config.limits,
        history,
        persist: (msg) => this.store.appendMessage(req.session.id, run.id, msg),
        emit,
        audit: (e) => this.store.audit({ ...auditBase, ...e }),
        signal: controller.signal,
      });
      status = result.status;
      usage = result.usage;
      if (status === 'cancelled' && controller.signal.reason instanceof Error && controller.signal.reason.message === 'timeout') {
        status = 'error';
        error = `The request took longer than ${Math.round(this.config.limits.runTimeoutMs / 60_000)} minutes and was stopped.`;
      }
    } catch (err) {
      status = 'error';
      error = (err as Error).message || 'The assistant failed';
    } finally {
      clearTimeout(timeout);
      if (error) emit('run_error', { message: error });
      emit('done', { status, usage, error });
      this.store.finishRun(run.id, status, usage, error);
      this.store.audit({ ...auditBase, action: 'run_finish', status: status === 'done' ? 'ok' : status === 'cancelled' ? 'cancelled' : 'error', detail: { status, usage, error } });
      this.live.delete(run.id);
      bus.emit('close');
    }
  }

  cancel(runId: string, byUserId: string, projectId: string): boolean {
    const live = this.live.get(runId);
    if (!live) return false;
    const run = this.store.getRun(runId);
    this.store.audit({ userId: byUserId, projectId, sessionId: run?.sessionId, runId, action: 'run_cancel', status: 'ok' });
    live.controller.abort(new Error('cancelled'));
    return true;
  }

  /**
   * Replays stored events after `afterId`, then follows the live run until
   * it finishes. Live events that race the replay are buffered and deduped.
   */
  subscribe(runId: string, afterId: number, onEvent: (e: RunEvent) => void, onClose: () => void): () => void {
    const live = this.live.get(runId);
    let lastId = afterId;
    let replaying = true;
    const queued: RunEvent[] = [];
    const deliver = (e: RunEvent) => { if (e.id > lastId) { lastId = e.id; onEvent(e); } };
    const onLive = (e: RunEvent) => (replaying ? queued.push(e) : deliver(e));
    const onDone = () => { cleanup(); onClose(); };
    const cleanup = () => { live?.bus.off('event', onLive); live?.bus.off('close', onDone); };
    if (live) { live.bus.on('event', onLive); live.bus.on('close', onDone); }
    for (const e of this.store.listEvents(runId, afterId)) deliver(e);
    replaying = false;
    for (const e of queued) deliver(e);
    if (!live || !this.live.has(runId)) { cleanup(); queueMicrotask(onClose); }
    return cleanup;
  }

  /** Graceful shutdown: cancel everything still running. */
  shutdown() {
    for (const l of this.live.values()) l.controller.abort(new Error('shutdown'));
  }
}
