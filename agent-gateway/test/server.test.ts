import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { MockProvider } from '../src/providers/mock.ts';
import { RunManager } from '../src/runs.ts';
import { buildApp } from '../src/server.ts';
import { SqliteStore } from '../src/store/sqlite.ts';
import { FakeAldine, sleep, testConfig } from './helpers.ts';

let app: FastifyInstance;
let base: string;
let store: SqliteStore;
const aldine = new FakeAldine();

before(async () => {
  const config = testConfig();
  store = new SqliteStore(':memory:');
  const runs = new RunManager({ store, aldine, providers: new Map([['mock', new MockProvider('mock', undefined, 5)]]), config });
  app = await buildApp({ config, store, aldine, runs });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/agent-gateway`;
});

after(async () => { await app.close(); store.close(); });

const as = (user: string, init: RequestInit = {}) => ({
  ...init,
  headers: { cookie: `aldine_session=${user}; other=secret`, 'x-aladine-request': '1', 'content-type': 'application/json', ...(init.headers as Record<string, string> ?? {}) },
});

async function json(res: Response) { return res.json() as Promise<any>; }

async function newSession(user = 'alice') {
  const r = await fetch(`${base}/projects/p1/sessions`, as(user, { method: 'POST', body: '{}' }));
  assert.equal(r.status, 201);
  return (await json(r)).session;
}

/** Reads an SSE stream until `done`, returning the events. */
async function readEvents(runId: string, user = 'alice', afterId = 0) {
  const res = await fetch(`${base}/runs/${runId}/events?after=${afterId}`, as(user));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const text = await res.text();
  return text.split('\n\n').filter((f) => f.startsWith('id:')).map((f) => {
    const id = Number(/^id: (\d+)/m.exec(f)![1]);
    const type = /^event: (.+)$/m.exec(f)![1];
    const data = JSON.parse(/^data: (.*)$/m.exec(f)![1]);
    return { id, type, data };
  });
}

async function send(sid: string, text: string, user = 'alice', extra: Record<string, unknown> = {}) {
  return fetch(`${base}/sessions/${sid}/messages`, as(user, {
    method: 'POST',
    body: JSON.stringify({ text, context: { branch: 'main', openFile: 'intro.tex', cursor: { line: 2 } }, ...extra }),
  }));
}

test('requires an Aldine sign-in', async () => {
  const r = await fetch(`${base}/config`);
  assert.equal(r.status, 401);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('config lists enabled models without secrets', async () => {
  const c = await json(await fetch(`${base}/config`, as('alice')));
  assert.equal(c.defaultModel, 'mock:scripted');
  assert.equal(c.user.name, 'Alice');
  assert.ok(!JSON.stringify(c).includes('apiKey'));
});

test('mutations need the request header and same-origin', async () => {
  const noHeader = await fetch(`${base}/projects/p1/sessions`, { method: 'POST', headers: { cookie: 'aldine_session=alice', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403);
  const crossSite = await fetch(`${base}/projects/p1/sessions`, as('alice', { method: 'POST', body: '{}', headers: { 'sec-fetch-site': 'cross-site' } }));
  assert.equal(crossSite.status, 403);
});

test('projects the user cannot open are 404', async () => {
  assert.equal((await fetch(`${base}/projects/p1/sessions`, as('carol'))).status, 404);
  assert.equal((await fetch(`${base}/projects/nope/sessions`, as('alice'))).status, 404);
});

test('a message streams a run with context, tool activity and text', async () => {
  const s = await newSession();
  const r = await send(s.id, 'What does the intro say? [[tool:read_file {"path":"intro.tex"}]]');
  assert.equal(r.status, 202);
  const { run } = await json(r);
  const events = await readEvents(run.id);
  const types = events.map((e) => e.type);
  assert.equal(types[types.length - 1], 'done');
  assert.equal(events[events.length - 1].data.status, 'done');
  assert.ok(types.includes('tool_start') && types.includes('tool_end'));
  const text = events.filter((e) => e.type === 'text').map((e) => e.data.delta).join('');
  assert.match(text, /^Working on it\.Done: /);

  const detail = await json(await fetch(`${base}/sessions/${s.id}`, as('alice')));
  assert.equal(detail.session.title, 'What does the intro say? [[tool:read_file {"path":"intro.tex"}]]'.slice(0, 59) + '…');
  const first = detail.messages[0];
  assert.equal(first.blocks[0].meta, 'context');
  assert.match(first.blocks[0].text, /open file: intro\.tex · cursor at line 2/);
  assert.match(first.blocks[0].text, /latest compile: failed with 1 error/);
  assert.equal(detail.activeRunId, null);
  assert.ok(detail.activity.some((e: any) => e.type === 'tool_end' && e.data.summary === 'Read intro.tex (4 lines)'));
  assert.ok(!detail.activity.some((e: any) => e.type === 'text'));
  // the gateway used the user's project credential, never the browser cookie
  assert.ok(aldine.calls.every((c) => c.token === 'tok-u-alice-p1'));
});

test('replay resumes after Last-Event-ID without duplicates', async () => {
  const s = await newSession();
  const { run } = await json(await send(s.id, 'hello'));
  const all = await readEvents(run.id);
  const mid = all[Math.floor(all.length / 2)].id;
  const rest = await readEvents(run.id, 'alice', mid);
  assert.deepEqual(rest.map((e) => e.id), all.filter((e) => e.id > mid).map((e) => e.id));
});

test('private sessions are invisible to collaborators until shared, then read-only', async () => {
  const s = await newSession('alice');
  await readEvents((await json(await send(s.id, 'secret question'))).run.id);

  assert.equal((await fetch(`${base}/sessions/${s.id}`, as('bob'))).status, 404);
  const bobList = await json(await fetch(`${base}/projects/p1/sessions`, as('bob')));
  assert.ok(!bobList.sessions.some((x: any) => x.id === s.id));

  assert.equal((await fetch(`${base}/sessions/${s.id}`, as('bob', { method: 'PATCH', body: JSON.stringify({ visibility: 'project' }) }))).status, 404);
  const shared = await json(await fetch(`${base}/sessions/${s.id}`, as('alice', { method: 'PATCH', body: JSON.stringify({ visibility: 'project' }) })));
  assert.equal(shared.session.visibility, 'project');

  const seen = await json(await fetch(`${base}/sessions/${s.id}`, as('bob')));
  assert.equal(seen.session.isOwner, false);
  assert.ok(seen.messages.length >= 2);
  assert.equal((await send(s.id, 'can I continue?', 'bob')).status, 403);
  assert.equal((await fetch(`${base}/sessions/${s.id}`, as('carol'))).status, 404);
  assert.ok(store.listAudit({ sessionId: s.id }).some((a) => a.action === 'session_visibility'));
});

test('one active run per session; cancel stops it', async () => {
  aldine.delayMs = 400;
  try {
    const s = await newSession();
    const { run } = await json(await send(s.id, 'slow [[tool:read_file {"path":"main.tex"}]]'));
    assert.equal((await send(s.id, 'again')).status, 409);
    await sleep(80);
    const c = await json(await fetch(`${base}/runs/${run.id}/cancel`, as('alice', { method: 'POST', body: '{}' })));
    assert.equal(c.cancelled, true);
    const events = await readEvents(run.id);
    assert.equal(events[events.length - 1].data.status, 'cancelled');
    assert.equal(store.getRun(run.id)!.status, 'cancelled');
  } finally {
    aldine.delayMs = 0;
  }
});

test('rejects unknown models, branches and oversize messages', async () => {
  const s = await newSession();
  assert.equal((await send(s.id, 'hi', 'alice', { model: 'anthropic:claude-opus-5-5' })).status, 400);
  const badBranch = await fetch(`${base}/sessions/${s.id}/messages`, as('alice', { method: 'POST', body: JSON.stringify({ text: 'hi', context: { branch: 'nope' } }) }));
  assert.equal(badBranch.status, 400);
  assert.equal((await send(s.id, 'x'.repeat(30_000))).status, 413);
});

test('provider internals are not exposed', async () => {
  const s = await newSession();
  await readEvents((await json(await send(s.id, 'hello'))).run.id);
  store.appendMessage(s.id, null, { role: 'assistant', blocks: [{ type: 'opaque', provider: 'anthropic', model: 'm', data: { signature: 'SECRET' } }] });
  const detail = await fetch(`${base}/sessions/${s.id}`, as('alice'));
  assert.ok(!(await detail.text()).includes('SECRET'));
});
