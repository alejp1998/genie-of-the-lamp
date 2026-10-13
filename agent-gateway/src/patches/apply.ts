import { readFresh } from '../agent/tools.ts';
import { type AldineApi, AldineToolError, type Identity } from '../aldine/types.ts';
import type { Config } from '../config.ts';
import type { CompileOutcome, Proposal, ProposalChange, Session, Store } from '../store/types.ts';
import { describeFailure, type EditSpec, fileDiff, resolveEdits, spliceEdits } from './anchors.ts';

/** Aldine's commit message limit (apps/server/src/util.ts COMMIT_MESSAGE_MAX). */
const COMMIT_MESSAGE_MAX = 200;
const COMPILE_TIMEOUT_MS = 180_000;

export class ProposalError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Accepts on one project run one at a time, so two approvals never race each other's rebase. */
const locks = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn);
  // The chain itself never rejects: each caller gets its own outcome from `next`.
  const tail = next.then(() => {}, () => {});
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return next;
}

export interface EditedParts {
  edits?: { change: number; edit: number; replacement: string }[];
  contents?: { change: number; content: string }[];
}

/** The user's Edit before Accept: replacements and new-file contents only; the anchors stay the model's. */
export function applyUserEdits(changes: ProposalChange[], parts: EditedParts): { changes: ProposalChange[]; edited: boolean } {
  const out: ProposalChange[] = changes.map((c) => ({ ...c, edits: c.edits?.map((e) => ({ ...e })) }));
  let edited = false;
  for (const e of parts.edits ?? []) {
    const c = out[e.change];
    const target = c?.kind === 'edit' ? c.edits?.[e.edit] : undefined;
    if (!target) throw new ProposalError(`There is no edit ${e.edit + 1} in change ${e.change + 1}`, 400);
    if (target.replacement !== e.replacement) { target.replacement = e.replacement; edited = true; }
  }
  for (const e of parts.contents ?? []) {
    const c = out[e.change];
    if (!c || c.kind !== 'create') throw new ProposalError(`Change ${e.change + 1} does not create a file`, 400);
    if (c.content !== e.content) { c.content = e.content; edited = true; }
  }
  return { changes: out, edited };
}

export function commitMessage(p: Proposal, session: Session): string {
  const trailers = [
    `Agent-Session: ${session.id.slice(0, 8)}`,
    `Agent-Proposal: ${p.id.slice(0, 8)}`,
    `Agent-Model: ${p.provider}:${p.model}`,
    ...(p.base.head ? [`Base-Revision: ${p.base.head}`] : []),
  ].join('\n');
  const room = COMMIT_MESSAGE_MAX - trailers.length - 2;
  const summary = p.summary.replace(/\s+/g, ' ').trim();
  return `${summary.length > room ? summary.slice(0, room - 1) + '…' : summary}\n\n${trailers}`;
}

function compileOutcome(r: any): CompileOutcome {
  const errors = (r?.errors ?? []).filter((e: any) => e.type === 'error');
  return {
    ok: !!r?.ok,
    errorsTotal: typeof r?.errorsTotal === 'number' ? r.errorsTotal : errors.length,
    errors: errors.slice(0, 10).map((e: any) => ({ file: e.file ?? null, line: e.line ?? null, message: String(e.message ?? '') })),
    ...(r?.timedOut ? { timedOut: true } : {}),
  };
}

export interface AcceptDeps {
  store: Store;
  aldine: AldineApi;
  config: Config;
}

/**
 * Accept: rebase each edit on the file as it is now (its quote must still be
 * there exactly once, so a collaborator's change to that text makes the
 * proposal stale instead of being overwritten), then write everything in one
 * all-or-nothing batch at the version just read. Compiles afterwards in the
 * background; the proposal's `compile` fills in when it finishes.
 */
export async function acceptProposal(deps: AcceptDeps, args: { proposal: Proposal; session: Session; identity: Identity; parts: EditedParts }): Promise<Proposal> {
  const { store, aldine, config } = deps;
  const { session, identity } = args;
  return serialized(args.proposal.projectId, async () => {
    const proposal = store.getProposal(args.proposal.id)!;
    if (proposal.status !== 'pending') throw new ProposalError(`This proposal is already ${proposal.status}`, 409);
    const { changes, edited } = applyUserEdits(proposal.changes, args.parts);
    store.updateProposal(proposal.id, { status: 'applying' });
    const token = await aldine.credential(identity, proposal.projectId);
    const reader = { aldine, token, projectId: proposal.projectId, branch: proposal.branch, signal: AbortSignal.timeout(60_000), limits: config.limits };
    const audit = (action: string, status: 'ok' | 'error' | 'denied', detail?: unknown) => store.audit({ userId: identity.user.id, projectId: proposal.projectId, sessionId: session.id, runId: proposal.runId, action, status, detail });

    const stale = (reason: string) => {
      const p = store.updateProposal(proposal.id, { status: 'stale', reason, decidedBy: identity.user.id, decidedByName: identity.user.name, decidedAt: new Date().toISOString() })!;
      audit('proposal_accept', 'denied', { proposal: proposal.id, reason });
      return p;
    };

    // Rebase on the current text and build the batch.
    const files: Record<string, unknown>[] = [];
    const patches: string[] = [];
    let added = 0;
    let removed = 0;
    try {
      for (const c of changes) {
        if (c.kind === 'edit') {
          const f = await readFresh(reader, c.path);
          const res = resolveEdits(f.content, c.edits as EditSpec[]);
          if (!res.ok) return stale(`${c.path} changed since the proposal: ${describeFailure(c.path, res)}`);
          // Pin each edit to the match just resolved, so Aldine applies it to the same text.
          const pinned = (c.edits as EditSpec[]).map((e, i) => {
            const at = res.ranges[i].from;
            let n = 0;
            for (let k = f.content.indexOf(e.quote); k >= 0 && k <= at; k = f.content.indexOf(e.quote, k + 1)) n++;
            return { quote: e.quote, replacement: e.replacement, ...(n > 1 || e.occurrence ? { occurrence: n } : {}) };
          });
          files.push({ path: c.path, edits: pinned, base_version: f.contentVersion });
          const d = fileDiff(c.path, f.content, spliceEdits(f.content, c.edits as EditSpec[], res.ranges));
          patches.push(d.patch); added += d.added; removed += d.removed;
        } else {
          let exists = false;
          try { await readFresh(reader, c.path); exists = true; } catch (err) { if (!(err instanceof AldineToolError)) throw err; }
          if (exists) return stale(`${c.path} was created by someone else since the proposal`);
          files.push({ path: c.path, content: c.content ?? '' });
          const d = fileDiff(c.path, null, c.content ?? '');
          patches.push(d.patch); added += d.added;
        }
      }
    } catch (err) {
      store.updateProposal(proposal.id, { status: 'pending' });
      throw new ProposalError(`Could not read the project to apply the change: ${(err as Error).message}`, 502);
    }

    const message = commitMessage({ ...proposal, changes }, session);
    let result: any;
    try {
      result = await aldine.callTool(token, 'batch_write', { project: proposal.projectId, branch: proposal.branch, files, message }, { timeoutMs: 60_000 });
    } catch (err) {
      if (err instanceof AldineToolError) {
        const p = store.updateProposal(proposal.id, { status: 'failed', reason: err.message, decidedBy: identity.user.id, decidedByName: identity.user.name, decidedAt: new Date().toISOString() })!;
        audit('proposal_accept', 'error', { proposal: proposal.id, reason: err.message });
        return p;
      }
      store.updateProposal(proposal.id, { status: 'pending' });
      throw new ProposalError(`Aldine did not answer while applying the change: ${(err as Error).message}`, 502);
    }
    if (result?.error) {
      // version_conflict: someone typed between the re-read and the write.
      return stale(result.error === 'version_conflict' ? 'The file changed while the change was being applied; try Accept again' : `${result.error}: ${result.reason ?? ''}`.trim());
    }

    const now = new Date().toISOString();
    // Aldine names the commit the same way (gitops.agentAuthorFor); without accounts the writer is the operator.
    const author = `${identity.authEnabled ? identity.user.name : 'Operator'} (via ${config.agentLabel})`;
    const applied = store.updateProposal(proposal.id, {
      status: 'applied', changes, edited, diff: patches.join(''), added, removed,
      commit: result?.commit ?? null, author, decidedBy: identity.user.id, decidedByName: identity.user.name, decidedAt: now, reason: null,
    })!;
    // The attribution record the spec asks for; the commit itself carries short references to it.
    const run = store.getRun(proposal.runId);
    audit('proposal_accept', 'ok', {
      project_id: proposal.projectId,
      session_id: session.id,
      proposal_id: proposal.id,
      initiated_by_user_id: session.ownerId,
      approved_by_user_id: identity.user.id,
      agent_id: config.agentId,
      provider: proposal.provider,
      model: proposal.model,
      tool_calls: store.listEvents(proposal.runId).filter((e) => e.type === 'tool_start').map((e) => (e.data as { name: string }).name),
      base_revision: proposal.base.head,
      resulting_revision: result?.head ?? null,
      git_commit: result?.commit ?? null,
      author,
      edited_by_user: edited,
      visibility: session.visibility,
      run_status: run?.status ?? null,
      created_at: now,
    });

    void aldine.callTool(token, 'compile', { project: proposal.projectId, branch: proposal.branch }, { timeoutMs: COMPILE_TIMEOUT_MS })
      .then((r) => compileOutcome(r))
      .catch((err) => ({ ok: false, errorsTotal: 0, errors: [{ file: null, line: null, message: `Compile did not run: ${(err as Error).message}` }] }))
      .then((outcome) => {
        store.updateProposal(proposal.id, { compile: outcome });
        audit('proposal_compile', outcome.ok ? 'ok' : 'error', { proposal: proposal.id, ok: outcome.ok, errorsTotal: outcome.errorsTotal });
      });
    return applied;
  });
}

export function rejectProposal(store: Store, args: { proposal: Proposal; session: Session; identity: Identity }): Proposal {
  const { proposal, session, identity } = args;
  if (proposal.status !== 'pending' && proposal.status !== 'stale') throw new ProposalError(`This proposal is already ${proposal.status}`, 409);
  const p = store.updateProposal(proposal.id, { status: 'rejected', decidedBy: identity.user.id, decidedByName: identity.user.name, decidedAt: new Date().toISOString() })!;
  store.audit({ userId: identity.user.id, projectId: proposal.projectId, sessionId: session.id, runId: proposal.runId, action: 'proposal_reject', status: 'ok', detail: { proposal: proposal.id } });
  return p;
}

/** What the model hears at the start of its next run about proposals decided since. */
export function decisionsNote(decided: Proposal[]): string | null {
  if (!decided.length) return null;
  const lines = decided.map((p) => {
    const what = `“${p.summary}” (proposal ${p.id.slice(0, 8)})`;
    if (p.status === 'applied') {
      const compile = !p.compile ? 'the compile afterwards had not finished'
        : p.compile.ok ? 'the document compiled afterwards'
          : `the compile afterwards failed with ${p.compile.errorsTotal} error(s): ${p.compile.errors.slice(0, 3).map((e) => `${e.file ?? '?'}:${e.line ?? '?'} ${e.message}`).join('; ')}`;
      return `- ${what}: accepted${p.edited ? ' after the user edited it' : ''}, committed as ${p.commit ?? '(no commit)'}; ${compile}.`;
    }
    if (p.status === 'rejected') return `- ${what}: rejected; the files are unchanged.`;
    return `- ${what}: could not be applied (${p.reason ?? p.status}); the files are unchanged.`;
  });
  return `Since your last reply the user reviewed your proposals:\n${lines.join('\n')}`;
}
