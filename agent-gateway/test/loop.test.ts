import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeHistory, runLoop } from '../src/agent/loop.ts';
import { newRunState, READ_TOOLS } from '../src/agent/tools.ts';
import { MockProvider, type MockScript } from '../src/providers/mock.ts';
import type { ChatMessage } from '../src/providers/types.ts';
import { FakeAldine, testConfig } from './helpers.ts';

function harness(script: MockScript, opts: { limits?: Parameters<typeof testConfig>[0]; aldine?: FakeAldine } = {}) {
  const config = testConfig(opts.limits);
  const aldine = opts.aldine ?? new FakeAldine();
  const controller = new AbortController();
  const events: { type: string; data: any }[] = [];
  const persisted: ChatMessage[] = [];
  const audits: any[] = [];
  const history: ChatMessage[] = [{ role: 'user', blocks: [{ type: 'text', text: 'help' }] }];
  const run = () => runLoop({
    provider: new MockProvider('mock', script, 0),
    model: 'scripted',
    system: 'test',
    tools: READ_TOOLS,
    toolCtx: { aldine, token: 't', projectId: 'p1', branch: 'main', signal: controller.signal, limits: config.limits, state: newRunState() },
    limits: config.limits,
    history,
    persist: (m) => persisted.push(m),
    emit: (type, data) => events.push({ type, data }),
    audit: (e) => audits.push(e),
    signal: controller.signal,
  });
  return { run, events, persisted, audits, controller, aldine };
}

test('runs read-only tools, then answers; every tool call gets a result', async () => {
  let turn = 0;
  const h = harness(() => {
    turn++;
    if (turn === 1) return { text: 'Looking.', toolCalls: [{ name: 'read_file', input: { path: 'intro.tex' } }, { name: 'search_project', input: { query: 'knuth84' } }] };
    return { text: 'Intro defines swarm robotics.' };
  });
  const r = await h.run();
  assert.equal(r.status, 'done');
  assert.deepEqual(h.persisted.map((m) => m.role), ['assistant', 'user', 'assistant']);
  const results = h.persisted[1].blocks.filter((b) => b.type === 'tool_result') as any[];
  assert.equal(results.length, 2);
  assert.ok(results.every((b) => !b.isError));
  const search = JSON.parse(results[1].content);
  assert.deepEqual(search.matches.map((m: any) => `${m.path}:${m.line}`).sort(), ['main.tex:5', 'refs.bib:1']);
  const starts = h.events.filter((e) => e.type === 'tool_start').map((e) => e.data.activity);
  assert.deepEqual(starts, ['Reading intro.tex…', 'Searching for “knuth84”…']);
  assert.ok(h.events.some((e) => e.type === 'tool_end' && e.data.summary === 'Read intro.tex (4 lines)'));
  assert.equal(h.audits.filter((a) => a.action === 'tool_call' && a.status === 'ok').length, 2);
  // search reused the full read of intro.tex instead of fetching it again
  assert.equal(h.aldine.calls.filter((c) => c.name === 'read_file' && c.args.path === 'intro.tex').length, 1);
});

test('invalid tool input and unknown tools come back as errors the model can see', async () => {
  let turn = 0;
  const h = harness(() => (++turn === 1
    ? { toolCalls: [{ name: 'read_file', input: { path: 42 } }, { name: 'write_file', input: { path: 'x', content: 'y' } }] }
    : { text: 'ok' }));
  await h.run();
  const results = h.persisted[1].blocks as any[];
  assert.ok(results[0].isError && /Invalid input for read_file/.test(results[0].content));
  assert.ok(results[1].isError && /no tool named "write_file"/.test(results[1].content));
  assert.ok(h.audits.every((a) => a.status === 'denied'));
  assert.equal(h.aldine.calls.length, 0);
});

test('Aldine tool refusals are passed through as tool errors', async () => {
  let turn = 0;
  const h = harness(() => (++turn === 1 ? { toolCalls: [{ name: 'read_file', input: { path: 'missing.tex' } }] } : { text: 'not found' }));
  const r = await h.run();
  assert.equal(r.status, 'done');
  const res = h.persisted[1].blocks[0] as any;
  assert.ok(res.isError);
  assert.match(res.content, /No file at missing\.tex/);
});

test('stops at the iteration limit', async () => {
  const h = harness(() => ({ toolCalls: [{ name: 'list_files', input: {} }] }), { limits: { maxIterations: 3 } });
  const r = await h.run();
  assert.equal(r.status, 'limit');
  assert.equal(h.persisted.filter((m) => m.role === 'assistant').length, 3);
  assert.ok(h.events.some((e) => e.type === 'notice' && /Stopped after 3 steps/.test(e.data.message)));
});

test('compile is capped per run', async () => {
  const h = harness(() => ({ toolCalls: [{ name: 'compile', input: {} }] }), { limits: { maxIterations: 4, maxCompilesPerRun: 2 } });
  await h.run();
  assert.equal(h.aldine.calls.filter((c) => c.name === 'compile').length, 2);
  const third = h.persisted[5].blocks[0] as any;
  assert.ok(third.isError && /Compile limit/.test(third.content));
});

test('cancelling mid-tool records a cancelled result so history stays valid', async () => {
  const aldine = new FakeAldine();
  aldine.delayMs = 500;
  const h = harness(() => ({ toolCalls: [{ name: 'read_file', input: { path: 'main.tex' } }] }), { aldine });
  const p = h.run();
  setTimeout(() => h.controller.abort(), 50);
  const r = await p;
  assert.equal(r.status, 'cancelled');
  assert.deepEqual(h.persisted.map((m) => m.role), ['assistant', 'user']);
  const res = h.persisted[1].blocks[0] as any;
  assert.equal(res.type, 'tool_result');
  assert.ok(res.isError && /Cancelled/.test(res.content));
});

test('tool results are clipped to the configured size', async () => {
  const aldine = new FakeAldine();
  aldine.files['big.tex'] = 'x'.repeat(10_000);
  let turn = 0;
  const h = harness(() => (++turn === 1 ? { toolCalls: [{ name: 'read_file', input: { path: 'big.tex' } }] } : { text: 'ok' }), { aldine, limits: { maxToolResultChars: 2000 } });
  await h.run();
  const res = h.persisted[1].blocks[0] as any;
  assert.ok(res.content.length < 2200);
  assert.match(res.content, /truncated/);
});

test('normalizeHistory merges adjacent same-role turns in order', () => {
  const merged = normalizeHistory([
    { role: 'user', blocks: [{ type: 'text', text: 'a' }] },
    { role: 'assistant', blocks: [{ type: 'tool_call', id: '1', name: 'list_files', input: {} }] },
    { role: 'user', blocks: [{ type: 'tool_result', id: '1', content: 'x', isError: true }] },
    { role: 'user', blocks: [{ type: 'text', text: 'b' }] },
  ]);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged[2].blocks.map((b) => b.type), ['tool_result', 'text']);
});
