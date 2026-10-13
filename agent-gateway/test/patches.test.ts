import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { fileDiff, resolveEdits, spliceEdits } from '../src/patches/anchors.ts';
import { commitMessage, decisionsNote } from '../src/patches/apply.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { RunManager } from '../src/runs.ts';
import { buildApp } from '../src/server.ts';
import { SqliteStore } from '../src/store/sqlite.ts';
import type { Proposal, Session } from '../src/store/types.ts';
import { FakeAldine, FILES, sleep, testConfig } from './helpers.ts';

// ---------- anchors ----------

test('anchors follow Aldine: min length, unique unless occurrence, no overlap', () => {
  const text = 'alpha beta gamma\nalpha beta delta\n';
  assert.match((resolveEdits(text, [{ quote: 'beta', replacement: 'x' }]) as any).reason, /at least 8/);
  const amb = resolveEdits(text, [{ quote: 'alpha beta', replacement: 'x' }]) as any;
  assert.equal(amb.ok, false);
  assert.match(amb.reason, /appears 2 times/);
  assert.deepEqual(amb.candidates.map((c: any) => c.line), [1, 2]);
  const second = resolveEdits(text, [{ quote: 'alpha beta', replacement: 'omega', occurrence: 2 }]);
  assert.ok(second.ok);
  assert.equal(spliceEdits(text, [{ quote: 'alpha beta', replacement: 'omega' }], (second as any).ranges), 'alpha beta gamma\nomega delta\n');
  const overlap = resolveEdits(text, [{ quote: 'alpha beta gamma', replacement: 'a' }, { quote: 'beta gamma', replacement: 'b' }]) as any;
  assert.match(overlap.reason, /overlaps/);
  const gone = resolveEdits(text, [{ quote: 'alpha beta epsilon', replacement: 'x' }]) as any;
  assert.match(gone.reason, /not in the file/);
  assert.ok(gone.candidates.length > 0);
});

test('diffs carry a diff --git header and counts', () => {
  const d = fileDiff('intro.tex', 'a\nb\nc\n', 'a\nB\nc\n');
  assert.match(d.patch, /^diff --git a\/intro\.tex b\/intro\.tex\n--- a\/intro\.tex\n\+\+\+ b\/intro\.tex\n@@ /);
  assert.deepEqual([d.added, d.removed], [1, 1]);
  const created = fileDiff('sec/new.tex', null, 'x\ny\n');
  assert.match(created.patch, /new file mode 100644\n--- \/dev\/null\n\+\+\+ b\/sec\/new\.tex/);
  assert.equal(created.added, 2);
});

test('commit message fits Aldine\'s 200-character limit and keeps the trailers', () => {
  const p = { id: 'f00dfeed-1234', summary: 'x'.repeat(400), provider: 'anthropic', model: 'claude-haiku-5-5', base: { head: 'abc1234', versions: {} } } as unknown as Proposal;
  const m = commitMessage(p, { id: '7c1e4a2b-9999' } as Session);
  assert.ok(m.length <= 200, String(m.length));
  assert.match(m, /\n\nAgent-Session: 7c1e4a2b\nAgent-Proposal: f00dfeed\nAgent-Model: anthropic:claude-haiku-5-5\nBase-Revision: abc1234$/);
});

test('decision notes summarise outcomes for the model', () => {
  const base = { id: 'p1234567', summary: 'Fix it', changes: [{ path: 'a.tex', kind: 'edit' }], edited: true, commit: 'abc', compile: { ok: false, errorsTotal: 1, errors: [{ file: 'a.tex', line: 3, message: 'Undefined' }] } } as unknown as Proposal;
  const note = decisionsNote([{ ...base, status: 'applied' }, { ...base, id: 'p2', status: 'rejected' }])!;
  assert.match(note, /accepted after the user edited it, committed as abc; the compile afterwards failed with 1 error\(s\): a\.tex:3 Undefined/);
  assert.match(note, /rejected; the files are unchanged/);
  assert.equal(decisionsNote([]), null);
});

// ---------- end to end through the API ----------

let app: FastifyInstance;
let gw: string;
let store: SqliteStore;
let aldine: FakeAldine;

before(async () => {
  const config = testConfig();
  store = new SqliteStore(':memory:');
  aldine = new FakeAldine();
  const runs = new RunManager({ store, aldine, providers: new Map([['mock', new MockProvider('mock', undefined, 0)]]), config });
  app = await buildApp({ config, store, aldine, runs });
  await app.listen({ host: '127.0.0.1', port: 0 });
  gw = `http://127.0.0.1:${(app.server.address() as any).port}/agent-gateway`;
});
after(async () => { await app.close(); store.close(); });
beforeEach(() => {
  aldine.files = { ...FILES };
  aldine.fileVersions = {};
  aldine.commits = [];
  aldine.compileOk = true;
});

const as = (user: string, init: RequestInit = {}) => ({ ...init, headers: { cookie: `aldine_session=${user}`, 'x-genie-request': '1', 'content-type': 'application/json' } });
const j = async (r: Response) => r.json() as Promise<any>;

const PATCH = {
  summary: 'Tighten the intro sentence',
  changes: [{ path: 'intro.tex', edits: [{ quote: 'Swarm robotics is a field of study.', replacement: 'Swarm robotics studies large groups of simple robots.' }] }],
};

/** Has the mock model call propose_patch with `patch`, waits for the run, returns the stored proposal. */
async function propose(patch: unknown = PATCH, user = 'alice') {
  const s = (await j(await fetch(`${gw}/projects/p1/sessions`, as(user, { method: 'POST', body: '{}' })))).session;
  const sent = await j(await fetch(`${gw}/sessions/${s.id}/messages`, as(user, { method: 'POST', body: JSON.stringify({ text: `Please [[tool:propose_patch ${JSON.stringify(patch)}]]`, context: { branch: 'main' } }) })));
  const sse = await (await fetch(`${gw}/runs/${sent.run.id}/events`, as(user))).text();
  const detail = await j(await fetch(`${gw}/sessions/${s.id}`, as(user)));
  return { session: s, sse, detail, proposal: detail.proposals[0] as Proposal };
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await sleep(25);
  }
}

test('propose_patch stores a reviewable diff and writes nothing', async () => {
  const { sse, proposal, detail } = await propose();
  assert.match(sse, /event: proposal\n/);
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.summary, 'Tighten the intro sentence');
  assert.match(proposal.diff, /-Swarm robotics is a field of study\.\n\+Swarm robotics studies large groups of simple robots\./);
  assert.deepEqual([proposal.added, proposal.removed], [1, 1]);
  assert.equal(proposal.toolCallId, detail.messages[1].blocks.find((b: any) => b.type === 'tool_call').id);
  assert.equal(aldine.files['intro.tex'], FILES['intro.tex']);
  assert.equal(aldine.commits.length, 0);
});

test('a proposal whose quote is not in the file is refused with candidates for the model', async () => {
  const { detail } = await propose({ summary: 'x', changes: [{ path: 'intro.tex', edits: [{ quote: 'Swarm robotics is a branch of science.', replacement: 'y' }] }] });
  assert.equal(detail.proposals.length, 0);
  const result = detail.messages[2].blocks[0];
  assert.ok(result.isError);
  assert.match(result.content, /not in the file.*Candidates: line 2/);
});

test('accept applies through batch_write as the approver, then compiles', async () => {
  const { proposal } = await propose();
  const res = await j(await fetch(`${gw}/proposals/${proposal.id}/accept`, as('alice', { method: 'POST', body: '{}' })));
  assert.equal(res.proposal.status, 'applied');
  assert.equal(res.proposal.author, 'Alice (via Paper Assistant)');
  assert.equal(aldine.files['intro.tex'].split('\n')[1], 'Swarm robotics studies large groups of simple robots.');
  assert.equal(aldine.commits.length, 1);
  assert.equal(res.proposal.commit, aldine.commits[0].hash);
  assert.equal(aldine.commits[0].token, 'tok-u-alice-p1');
  assert.match(aldine.commits[0].message, /^Tighten the intro sentence\n\nAgent-Session: .{8}\nAgent-Proposal: .{8}\nAgent-Model: mock:scripted\nBase-Revision: /);
  const done = await waitFor(async () => j(await fetch(`${gw}/proposals/${proposal.id}`, as("alice"))), (r) => !!r.proposal.compile);
  assert.equal(done.proposal.compile.ok, true);
  const audit = store.listAudit({ sessionId: proposal.sessionId }).find((a) => a.action === 'proposal_accept')!;
  const rec = audit.detail as any;
  assert.equal(rec.initiated_by_user_id, 'u-alice');
  assert.equal(rec.agent_id, 'paper-assistant-v1');
  assert.equal(rec.git_commit, res.proposal.commit);
  assert.ok(rec.tool_calls.includes('propose_patch'));
  assert.equal(rec.visibility, 'private');
  // A second accept is refused.
  assert.equal((await fetch(`${gw}/proposals/${proposal.id}/accept`, as('alice', { method: 'POST', body: '{}' }))).status, 409);
});

test('edit before accept commits the user\'s wording and records it', async () => {
  const { proposal } = await propose();
  const res = await j(await fetch(`${gw}/proposals/${proposal.id}/accept`, as('alice', { method: 'POST', body: JSON.stringify({ edits: [{ change: 0, edit: 0, replacement: 'Swarm robotics coordinates many robots.' }] }) })));
  assert.equal(res.proposal.status, 'applied');
  assert.equal(res.proposal.edited, true);
  assert.match(aldine.files['intro.tex'], /Swarm robotics coordinates many robots\./);
  assert.match(res.proposal.diff, /\+Swarm robotics coordinates many robots\./);
});

test('reject leaves the document untouched', async () => {
  const { proposal } = await propose();
  const res = await j(await fetch(`${gw}/proposals/${proposal.id}/reject`, as('alice', { method: 'POST', body: '{}' })));
  assert.equal(res.proposal.status, 'rejected');
  assert.equal(aldine.files['intro.tex'], FILES['intro.tex']);
  assert.equal(aldine.commits.length, 0);
});

test('a collaborator editing elsewhere in the file does not block accept (anchor rebase)', async () => {
  const { proposal } = await propose();
  aldine.collaboratorEdit('intro.tex', aldine.files['intro.tex'] + 'A new closing paragraph by Bob.\n');
  const res = await j(await fetch(`${gw}/proposals/${proposal.id}/accept`, as('alice', { method: 'POST', body: '{}' })));
  assert.equal(res.proposal.status, 'applied');
  assert.match(aldine.files['intro.tex'], /studies large groups of simple robots\.[\s\S]*closing paragraph by Bob/);
});

test('a collaborator changing the quoted text makes the proposal stale instead of overwriting it', async () => {
  const { proposal } = await propose();
  aldine.collaboratorEdit('intro.tex', aldine.files['intro.tex'].replace('a field of study', 'a field Bob rewrote'));
  const r = await fetch(`${gw}/proposals/${proposal.id}/accept`, as('alice', { method: 'POST', body: '{}' }));
  const res = await j(r);
  assert.equal(res.proposal.status, 'stale');
  assert.match(res.proposal.reason, /intro\.tex changed since the proposal/);
  assert.match(aldine.files['intro.tex'], /a field Bob rewrote/);
  assert.equal(aldine.commits.length, 0);
});

test('only the session owner decides; shared viewers can only look', async () => {
  const { proposal, session } = await propose();
  assert.equal((await fetch(`${gw}/proposals/${proposal.id}/accept`, as('bob', { method: 'POST', body: '{}' }))).status, 404);
  await fetch(`${gw}/sessions/${session.id}`, as('alice', { method: 'PATCH', body: JSON.stringify({ visibility: 'project' }) }));
  assert.equal((await fetch(`${gw}/proposals/${proposal.id}`, as('bob'))).status, 200);
  assert.equal((await fetch(`${gw}/proposals/${proposal.id}/accept`, as('bob', { method: 'POST', body: '{}' }))).status, 403);
  assert.equal((await fetch(`${gw}/proposals/${proposal.id}/reject`, as('carol', { method: 'POST', body: '{}' }))).status, 404);
});

test('new files are proposed and created; existing ones must be edited', async () => {
  const { proposal } = await propose({ summary: 'Add a discussion section', changes: [{ path: 'sections/discussion.tex', new_content: '\\section{Discussion}\nText.\n' }] });
  assert.match(proposal.diff, /new file mode/);
  const res = await j(await fetch(`${gw}/proposals/${proposal.id}/accept`, as('alice', { method: 'POST', body: '{}' })));
  assert.equal(res.proposal.status, 'applied');
  assert.equal(aldine.files['sections/discussion.tex'], '\\section{Discussion}\nText.\n');
  const again = await propose({ summary: 'x', changes: [{ path: 'main.tex', new_content: 'oops' }] });
  assert.equal(again.detail.proposals.length, 0);
  assert.match(again.detail.messages[2].blocks[0].content, /already exists/);
});

test('the next run tells the model what happened to its proposals', async () => {
  aldine.compileOk = false;
  const { proposal, session } = await propose();
  await fetch(`${gw}/proposals/${proposal.id}/accept`, as('alice', { method: 'POST', body: '{}' }));
  await waitFor(async () => j(await fetch(`${gw}/proposals/${proposal.id}`, as("alice"))), (r) => !!r.proposal.compile);
  const sent = await j(await fetch(`${gw}/sessions/${session.id}/messages`, as('alice', { method: 'POST', body: JSON.stringify({ text: 'what now?', context: { branch: 'main' } }) })));
  await (await fetch(`${gw}/runs/${sent.run.id}/events`, as('alice'))).text();
  const detail = await j(await fetch(`${gw}/sessions/${session.id}`, as('alice')));
  const last = detail.messages.filter((m: any) => m.role === 'user' && m.runId === sent.run.id)[0];
  assert.match(last.blocks[0].text, /accepted, committed as .+; the compile afterwards failed with 1 error/);
  assert.equal(last.blocks[0].meta, 'context');
  assert.equal(store.getProposal(proposal.id)!.noted, true);
});

test('a newer proposal for the same file replaces the undecided one', async () => {
  const { session, proposal: first } = await propose();
  const sent = await j(await fetch(`${gw}/sessions/${session.id}/messages`, as('alice', { method: 'POST', body: JSON.stringify({ text: `Another version [[tool:propose_patch ${JSON.stringify({ ...PATCH, summary: 'Second try' })}]]`, context: { branch: 'main' } }) })));
  await (await fetch(`${gw}/runs/${sent.run.id}/events`, as('alice'))).text();
  const detail = await j(await fetch(`${gw}/sessions/${session.id}`, as('alice')));
  const old = detail.proposals.find((p: any) => p.id === first.id);
  const fresh = detail.proposals.find((p: any) => p.summary === 'Second try');
  assert.equal(old.status, 'superseded');
  assert.match(old.reason, new RegExp(fresh.id.slice(0, 8)));
  assert.equal(fresh.status, 'pending');
  assert.equal((await fetch(`${gw}/proposals/${first.id}/accept`, as('alice', { method: 'POST', body: '{}' }))).status, 409);
  const result = JSON.parse(detail.messages.filter((m: any) => m.runId === sent.run.id && m.role === 'user')[1].blocks[0].content);
  assert.deepEqual(result.replaced, [first.id.slice(0, 8)]);
});

// ---------- review comments ----------

const COMMENT = { id: 'c1', branch: 'main', file: 'intro.tex', anchor: { from: 0, to: 10, quote: 'Swarm robotics is a field of study.' }, author: 'Bob', body: 'Too vague, say what is studied.', resolved: false, createdAt: '2026-10-13T10:00:00Z', replies: [] };

test('list_comments shows open threads with file, line and quote', async () => {
  aldine.comments = [COMMENT, { ...COMMENT, id: 'c2', resolved: true, body: 'old' }];
  const s = (await j(await fetch(`${gw}/projects/p1/sessions`, as('alice', { method: 'POST', body: '{}' })))).session;
  const sent = await j(await fetch(`${gw}/sessions/${s.id}/messages`, as('alice', { method: 'POST', body: JSON.stringify({ text: 'handle the review [[tool:list_comments {}]]', context: { branch: 'main' } }) })));
  await (await fetch(`${gw}/runs/${sent.run.id}/events`, as('alice'))).text();
  const detail = await j(await fetch(`${gw}/sessions/${s.id}`, as('alice')));
  const res = JSON.parse(detail.messages[2].blocks[0].content);
  assert.equal(res.comments.length, 1);
  assert.deepEqual([res.comments[0].id, res.comments[0].file, res.comments[0].line, res.comments[0].author], ['c1', 'intro.tex', 2, 'Bob']);
  assert.equal(res.resolvedHidden, 1);
});

test('accepting a proposal that resolves a comment replies, resolves, and continues to the next item', async () => {
  aldine.comments = [structuredClone(COMMENT)];
  aldine.replies = [];
  const { proposal, session } = await propose({ ...JSON.parse(JSON.stringify(PATCH)), resolves: [{ comment_id: 'c1', reply: 'Made it concrete.' }], continue_after_review: true });
  assert.equal(proposal.resolves![0].author, 'Bob');
  assert.equal(proposal.continueAfterReview, true);
  const res = await j(await fetch(`${gw}/proposals/${proposal.id}/accept`, as('alice', { method: 'POST', body: '{}' })));
  assert.equal(res.proposal.resolves[0].done, true);
  assert.equal(aldine.comments[0].resolved, true);
  assert.match(aldine.replies[0].body, new RegExp(`^Made it concrete\\.\\n\\n\\(${res.proposal.commit.slice(0, 7)}\\)$`));
  // After the typeset reports, the assistant is resumed with the decision in hand.
  const after = await waitFor(async () => j(await fetch(`${gw}/proposals/${proposal.id}`, as('alice'))), (r) => !!r.proposal.continuedRunId);
  const runId = after.proposal.continuedRunId;
  assert.ok(runId);
  await (await fetch(`${gw}/runs/${runId}/events`, as('alice'))).text();
  const detail = await j(await fetch(`${gw}/sessions/${session.id}`, as('alice')));
  const cont = detail.messages.find((m: any) => m.runId === runId && m.role === 'user');
  assert.ok(cont.blocks.some((b: any) => b.note === 'continue'));
  assert.ok(!cont.blocks.some((b: any) => b.type === 'text' && !b.meta), 'no visible user text in a continuation');
  assert.match(cont.blocks[0].text, /Replied to and resolved 1 of 1 review comment/);
});

test('reject continues too; proposals without continue_after_review do not; reply-only answers write nothing', async () => {
  aldine.comments = [structuredClone(COMMENT)];
  const a = await propose({ ...JSON.parse(JSON.stringify(PATCH)), continue_after_review: true });
  const r = await j(await fetch(`${gw}/proposals/${a.proposal.id}/reject`, as('alice', { method: 'POST', body: '{}' })));
  assert.ok(r.proposal.continuedRunId);
  await (await fetch(`${gw}/runs/${r.proposal.continuedRunId}/events`, as('alice'))).text();

  const b = await propose();
  const r2 = await j(await fetch(`${gw}/proposals/${b.proposal.id}/reject`, as('alice', { method: 'POST', body: '{}' })));
  assert.equal(r2.proposal.continuedRunId ?? null, null);

  aldine.commits = [];
  const c = await propose({ summary: 'Answer Bob', changes: [], resolves: [{ comment_id: 'c1', reply: 'Kept as is: the next sentence makes it concrete.' }] });
  const acc = await j(await fetch(`${gw}/proposals/${c.proposal.id}/accept`, as('alice', { method: 'POST', body: '{}' })));
  assert.equal(acc.proposal.status, 'applied');
  assert.equal(aldine.commits.length, 0);
  assert.equal(aldine.comments[0].resolved, true);
});

test('a decision made while the reply is still streaming continues once the run ends', async () => {
  aldine.delayMs = 0;
  const s = (await j(await fetch(`${gw}/projects/p1/sessions`, as('alice', { method: 'POST', body: '{}' })))).session;
  const patch = { ...JSON.parse(JSON.stringify(PATCH)), continue_after_review: true };
  const sent = await j(await fetch(`${gw}/sessions/${s.id}/messages`, as('alice', { method: 'POST', body: JSON.stringify({ text: `[[tool:propose_patch ${JSON.stringify(patch)}]]`, context: { branch: 'main' } }) })));
  // Reject as soon as the proposal exists, while the mock is still writing its closing text.
  const p = await waitFor(async () => store.listProposals(s.id)[0], (x) => !!x, 3000);
  await fetch(`${gw}/proposals/${p.id}/reject`, as('alice', { method: 'POST', body: '{}' }));
  await (await fetch(`${gw}/runs/${sent.run.id}/events`, as('alice'))).text();
  const later = await waitFor(async () => store.getProposal(p.id)!, (x) => !!x.continuedRunId, 3000);
  assert.ok(later.continuedRunId);
});

test('add_references: listed on the card, added through Aldine on Accept, keys reported to the model', async () => {
  aldine.refsAdded = [];
  const { proposal } = await propose({ summary: 'Add two references', changes: [], add_references: [{ id: '10.1186/s41018-018-0045-4' }, { id: 'fail' }] });
  assert.deepEqual(proposal.references!.map((r) => r.id), ['10.1186/s41018-018-0045-4', 'fail']);
  const res = await j(await fetch(`${gw}/proposals/${proposal.id}/accept`, as('alice', { method: 'POST', body: '{}' })));
  assert.equal(res.proposal.status, 'applied');
  assert.deepEqual(aldine.refsAdded, ['10.1186/s41018-018-0045-4', 'fail']);
  assert.equal(res.proposal.references[0].key, 'ref1');
  assert.match(res.proposal.references[1].error, /lookup failed/);
  const { decisionsNote } = await import('../src/patches/apply.ts');
  assert.match(decisionsNote([res.proposal])!, /References: \\cite\{ref1\} = 10\.1186\/s41018-018-0045-4; fail failed \(lookup failed\)/);
});
