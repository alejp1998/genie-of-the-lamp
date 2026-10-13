/**
 * Runs against a real Aldine server (AUTH_ENABLED=1, ALDINE_MCP=1):
 *   ALDINE_IT_URL=http://127.0.0.1:3000 npm test
 * Skipped otherwise. Compile assertions additionally need the compiler (ALDINE_IT_COMPILE=1).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { HttpAldine } from '../src/aldine/http.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { RunManager } from '../src/runs.ts';
import { buildApp } from '../src/server.ts';
import { SqliteStore } from '../src/store/sqlite.ts';
import { testConfig } from './helpers.ts';

const URL_ = process.env.ALDINE_IT_URL;
const skip = !URL_ && 'set ALDINE_IT_URL to run against a real Aldine';

async function register(name: string) {
  const email = `${name.toLowerCase()}-${crypto.randomBytes(4).toString('hex')}@it.example`;
  const res = await fetch(`${URL_}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct-horse-battery-9', name }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const cookie = /aldine_session=[^;]+/.exec(res.headers.get('set-cookie') ?? '')![0];
  return { email, cookie };
}

let alice: { email: string; cookie: string };
let bob: { email: string; cookie: string };
let projectId: string;
let app: FastifyInstance;
let store: SqliteStore;
let gw: string;
const aldine = new HttpAldine({ baseUrl: URL_ ?? 'http://unused', agentLabel: 'Paper Assistant' });

before(async () => {
  if (skip) return;
  alice = await register('Alice');
  bob = await register('Bob');
  const res = await fetch(`${URL_}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: alice.cookie },
    body: JSON.stringify({
      name: 'Gateway IT paper',
      files: {
        'main.tex': '\\documentclass{article}\n\\begin{document}\n\\input{intro}\n\\end{document}\n',
        'intro.tex': '\\section{Introduction}\\label{sec:intro}\nSwarm robotics studies many simple robots.\n\\undefinedmacro\n',
      },
    }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  projectId = (await res.json() as any).id;
  const share = await fetch(`${URL_}/api/projects/${projectId}/share`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: alice.cookie },
    body: JSON.stringify({ mode: 'private', collaborators: [bob.email] }),
  });
  assert.equal(share.status, 200, await share.clone().text());

  const config = testConfig();
  config.aldineUrl = URL_!;
  store = new SqliteStore(':memory:');
  const runs = new RunManager({ store, aldine, providers: new Map([['mock', new MockProvider('mock', undefined, 0)]]), config });
  app = await buildApp({ config, store, aldine, runs });
  await app.listen({ host: '127.0.0.1', port: 0 });
  gw = `http://127.0.0.1:${(app.server.address() as any).port}/agent-gateway`;
});

after(async () => { if (!skip) { await app.close(); store.close(); } });

test('identity and project access come from Aldine', { skip }, async () => {
  const me = await aldine.whoami(alice.cookie);
  assert.equal(me!.user.name, 'Alice');
  assert.equal(await aldine.whoami('aldine_session=bogus'), null);
  const p = await aldine.project(me!, projectId);
  assert.equal(p!.name, 'Gateway IT paper');
  assert.ok(p!.branches.includes('main'));
  const outsider = await register('Mallory');
  assert.equal(await aldine.project((await aldine.whoami(outsider.cookie))!, projectId), null);
});

test('minted credential reads files over MCP and is scoped to the project', { skip }, async () => {
  const me = (await aldine.whoami(alice.cookie))!;
  const token = await aldine.credential(me, projectId);
  assert.match(token, /^aldn_/);
  const r = await aldine.callTool(token, 'read_file', { project: projectId, branch: 'main', path: 'intro.tex' });
  assert.match(r.content, /Swarm robotics/);
  assert.equal(typeof r.contentVersion, 'number');
  const list = await aldine.callTool(token, 'list_projects', {});
  assert.deepEqual(list.map((p: any) => p.id), [projectId]);
  const tokens = await (await fetch(`${URL_}/api/tokens`, { headers: { cookie: alice.cookie } })).json() as any[];
  const mine = tokens.filter((t) => t.name === 'Paper Assistant (auto)');
  assert.equal(mine.length, 1);
  assert.deepEqual(mine[0].projectIds, [projectId]);
  assert.ok(mine[0].expiresAt);
});

test('full gateway run against real Aldine: context, tool call, persisted chat', { skip }, async () => {
  const h = { cookie: alice.cookie, 'x-aladine-request': '1', 'content-type': 'application/json' };
  const s = await (await fetch(`${gw}/projects/${projectId}/sessions`, { method: 'POST', headers: h, body: '{}' })).json() as any;
  const sent = await fetch(`${gw}/sessions/${s.session.id}/messages`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ text: 'Summarize [[tool:search_project {"query":"robots"}]]', context: { branch: 'main', openFile: 'intro.tex', cursor: { line: 2 } } }),
  });
  assert.equal(sent.status, 202, await sent.clone().text());
  const { run } = await sent.json() as any;
  const sse = await (await fetch(`${gw}/runs/${run.id}/events`, { headers: { cookie: alice.cookie } })).text();
  assert.match(sse, /event: done\ndata: \{"status":"done"/);
  assert.match(sse, /Found 1 matches in 1 files/);
  const detail = await (await fetch(`${gw}/sessions/${s.session.id}`, { headers: { cookie: alice.cookie } })).json() as any;
  assert.match(detail.messages[0].blocks[0].text, /around the cursor \(intro\.tex/);
  assert.match(detail.messages[0].blocks[0].text, /Swarm robotics studies many simple robots/);

  // Bob is a collaborator but cannot see Alice's private chat.
  assert.equal((await fetch(`${gw}/sessions/${s.session.id}`, { headers: { cookie: bob.cookie } })).status, 404);
});

test('compile reports structured errors', { skip: skip || (!process.env.ALDINE_IT_COMPILE && 'set ALDINE_IT_COMPILE=1 with the compiler running') }, async () => {
  const me = (await aldine.whoami(alice.cookie))!;
  const token = await aldine.credential(me, projectId);
  const r = await aldine.callTool(token, 'compile', { project: projectId, branch: 'main' }, { timeoutMs: 120_000 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e: any) => e.file === 'intro.tex' && /Undefined control sequence/.test(e.message)));
});
