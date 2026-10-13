/**
 * X-Aldine-Agent-Label on /mcp: writes commit as "<user> (via <label>)",
 * without it (or with a malformed one) they stay Claude's, and every agent
 * check (agent-activity, the review prompt) counts both.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-agent-label-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_MCP_TOKEN;
delete process.env.ALDINE_PROTECTED_PROJECTS;

const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const { registerRoutes } = await import('../src/routes.ts');
const { registerMcp } = await import('../src/mcp/server.ts');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const Fastify = (await import('fastify')).default;

// ---- the naming rules ----
eq(gitops.agentAuthorFor('Paper Assistant', 'Ada Lovelace'), 'Ada Lovelace (via Paper Assistant)', 'label + user name');
eq(gitops.agentAuthorFor(null, 'Ada'), 'Claude', 'no label: Claude, as upstream');
eq(gitops.agentAuthorFor('bad<label>', 'Ada'), 'Claude', 'a malformed label falls back to Claude');
eq(gitops.agentAuthorFor('Paper Assistant', null), 'Operator (via Paper Assistant)', 'no user (auth off): the operator');
eq(gitops.agentAuthorFor('PA', 'Eve (via X) <e>'), 'Eve via X e (via PA)', 'brackets in a name cannot fake the suffix');
check(gitops.isAgentAuthor('Claude'), 'Claude is an agent author');
check(gitops.isAgentAuthor('Ada (via Paper Assistant)'), 'a labelled write is an agent author');
check(!gitops.isAgentAuthor('Ada'), 'a person is not');
check(!gitops.isAgentAuthor('Aldine'), 'the autosave is not');

// ---- through /mcp ----
const app = Fastify();
await registerRoutes(app);
await registerMcp(app);
await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${app.server.address().port}`;

const ada = await auth.register('ada@example.com', 'password123', 'Ada');
const cookie = `aldine_session=${await auth.createSession(ada.id)}`;
const project = await store.createProject('Label test', { 'main.tex': 'First line of the paper.\nSecond line of the paper.\n' }, ada.id);
const { token } = await auth.createAccessToken(ada.id, 'Gateway', [project.id], null);

async function client(headers) {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}`, ...headers } } }));
  return c;
}
async function edit(c, quote, replacement) {
  const r = await c.callTool({ name: 'edit_file', arguments: { project: project.id, path: 'main.tex', edits: [{ quote, replacement }], message: `Edit: ${replacement}` } });
  const body = JSON.parse(r.content[0].text);
  check(!r.isError && body.commit, `edit committed (${r.content[0].text.slice(0, 120)})`);
  return body.commit;
}

const labelled = await client({ 'x-aldine-agent-label': 'Paper Assistant' });
await edit(labelled, 'First line of the paper.', 'First line, tightened.');
const plain = await client({});
await edit(plain, 'Second line of the paper.', 'Second line, by Claude.');
const forged = await client({ 'x-aldine-agent-label': '(via Someone Else)' });
await edit(forged, 'First line, tightened.', 'First line, again.');

const log = await gitops.log(project.id, 'main', 10);
eq(log.slice(0, 3).map((c) => c.author), ['Claude', 'Claude', 'Ada (via Paper Assistant)'], 'authors newest first: forged label ignored, plain is Claude, labelled names Ada');

const activity = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/agent-activity?branch=main`, headers: { cookie } })).json();
eq(activity.commitCount, 3, 'agent-activity counts labelled and Claude commits');
eq(activity.commits.map((c) => c.author), ['Claude', 'Claude', 'Ada (via Paper Assistant)'], 'and names each author');

await labelled.close(); await plain.close(); await forged.close();
await app.close();
console.log('agent-label: ok');
