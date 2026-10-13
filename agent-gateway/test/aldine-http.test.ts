import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpAldine, sessionCookie } from '../src/aldine/http.ts';

test('only the aldine_session cookie is forwarded', () => {
  assert.equal(sessionCookie('theme=dark; aldine_session=abc=def; other=1'), 'aldine_session=abc=def');
  assert.equal(sessionCookie('theme=dark'), '');
  assert.equal(sessionCookie(undefined), '');
});

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body?: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('whoami maps auth-off Aldine to a local user and caches lookups', async () => {
  const f = fakeFetch(() => ({ body: { authEnabled: false, user: null } }));
  const a = new HttpAldine({ baseUrl: 'http://aldine', agentLabel: 'PA', operatorToken: 'op', fetchImpl: f.impl });
  const id = await a.whoami('');
  assert.equal(id!.authEnabled, false);
  assert.equal(id!.user.id, 'local');
  await a.whoami('');
  assert.equal(f.calls.length, 1);
  assert.equal(await a.credential(id!, 'p1'), 'op');
});

test('signed-out users get null; signed-in identity carries the cookie', async () => {
  const f = fakeFetch((_u, init) => {
    const cookie = new Headers(init.headers).get('cookie');
    return { body: cookie === 'aldine_session=ok' ? { authEnabled: true, user: { id: 'u1', name: 'Ale', email: 'a@x' } } : { authEnabled: true, user: null } };
  });
  const a = new HttpAldine({ baseUrl: 'http://aldine', agentLabel: 'PA', fetchImpl: f.impl });
  assert.equal(await a.whoami('aldine_session=bad'), null);
  const id = await a.whoami('aldine_session=ok');
  assert.equal(id!.user.name, 'Ale');
  assert.equal(id!.cookie, 'aldine_session=ok');
});

test('project access is Aldine\'s answer for this user; 404/403 mean no access', async () => {
  const f = fakeFetch((url) => (url.endsWith('/api/projects/p1') ? { body: { id: 'p1', name: 'Paper', rootFile: 'main.tex', branches: [{ name: 'main' }, 'draft'] } } : { status: 404, body: { error: 'nf' } }));
  const a = new HttpAldine({ baseUrl: 'http://aldine', agentLabel: 'PA', fetchImpl: f.impl });
  const id = { authEnabled: true, user: { id: 'u1', name: 'Ale', email: null }, cookie: 'aldine_session=ok' };
  assert.deepEqual(await a.project(id, 'p1'), { id: 'p1', name: 'Paper', rootFile: 'main.tex', branches: ['main', 'draft'] });
  assert.equal(await a.project(id, 'p2'), null);
});

test('credentials: one short-lived, project-scoped token per user+project, minted once', async () => {
  let minted = 0;
  const f = fakeFetch((url, init) => {
    if (url.endsWith('/api/tokens') && init.method === 'POST') {
      minted++;
      return { body: { token: `aldn_${minted}`, id: `t${minted}` } };
    }
    return { status: 404 };
  });
  const a = new HttpAldine({ baseUrl: 'http://aldine', agentLabel: 'PA', fetchImpl: f.impl });
  const id = { authEnabled: true, user: { id: 'u1', name: 'Ale', email: null }, cookie: 'aldine_session=ok' };
  const [t1, t2] = await Promise.all([a.credential(id, 'p1'), a.credential(id, 'p1')]);
  assert.equal(t1, 'aldn_1');
  assert.equal(t2, 'aldn_1');
  assert.equal(await a.credential(id, 'p1'), 'aldn_1');
  assert.equal(minted, 1);
  const body = JSON.parse(f.calls[0].init.body as string);
  assert.deepEqual(body.projectIds, ['p1']);
  assert.equal(body.name, 'Paper Assistant (auto)');
  const ttl = Date.parse(body.expiresAt) - Date.now();
  assert.ok(ttl > 55 * 60_000 && ttl <= 60 * 60_000);
  assert.equal(new Headers(f.calls[0].init.headers).get('cookie'), 'aldine_session=ok');
  assert.equal(await a.credential(id, 'p2'), 'aldn_2');
});

test('auth-off Aldine without an operator token is a clear configuration error', async () => {
  const a = new HttpAldine({ baseUrl: 'http://aldine', agentLabel: 'PA', fetchImpl: fakeFetch(() => ({})).impl });
  await assert.rejects(a.credential({ authEnabled: false, user: { id: 'local', name: 'L', email: null }, cookie: '' }, 'p1'), /ALDINE_MCP_TOKEN/);
});
