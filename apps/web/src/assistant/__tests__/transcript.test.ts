import { describe, expect, it } from 'vitest';
import type { ChatMessage, RunEvent } from '../api';
import { applyEvent, buildTranscript, type LiveState } from '../transcript';

const msgs: ChatMessage[] = [
  { id: 1, runId: 'r1', role: 'user', createdAt: '', blocks: [{ type: 'text', text: '<editor_context>x</editor_context>', meta: 'context' }, { type: 'text', text: 'Why does it fail?' }] },
  { id: 2, runId: 'r1', role: 'assistant', createdAt: '', blocks: [{ type: 'opaque' }, { type: 'text', text: 'Checking.' }, { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.tex' } }] },
  { id: 3, runId: 'r1', role: 'user', createdAt: '', blocks: [{ type: 'tool_result', id: 'c1', content: '{"content":"x"}' }] },
  { id: 4, runId: 'r1', role: 'assistant', createdAt: '', blocks: [{ type: 'text', text: 'Line 3 is wrong.' }] },
  { id: 5, runId: 'r2', role: 'user', createdAt: '', blocks: [{ type: 'text', text: 'ctx', meta: 'context' }, { type: 'text', text: 'Again' }] },
];
const activity: RunEvent[] = [
  { id: 10, runId: 'r1', type: 'tool_start', data: { id: 'c1', name: 'read_file', activity: 'Reading a.tex…', input: { path: 'a.tex' } } },
  { id: 11, runId: 'r1', type: 'tool_end', data: { id: 'c1', name: 'read_file', ok: true, summary: 'Read a.tex (3 lines)' } },
  { id: 12, runId: 'r1', type: 'notice', data: { level: 'warn', message: 'Stopped after 12 steps.' } },
];

describe('buildTranscript', () => {
  it('hides the context block and opaque blocks, labels tools, places notices after their run', () => {
    const items = buildTranscript(msgs, activity);
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'assistant', 'notice', 'user']);
    expect(items[0]).toMatchObject({ text: 'Why does it fail?' });
    expect(items[2]).toMatchObject({ activity: 'Reading a.tex…', summary: 'Read a.tex (3 lines)', ok: true, running: false, output: '{"content":"x"}' });
    expect(items[4]).toMatchObject({ message: 'Stopped after 12 steps.' });
  });

  it('leaves the live run out', () => {
    const items = buildTranscript(msgs, activity, 'r2');
    expect(items[items.length - 1].kind).toBe('notice');
  });
});

describe('applyEvent', () => {
  it('streams text into one bubble, splits around tools, marks done', () => {
    let s: LiveState = { runId: 'r', userText: 'q', items: [], status: null, done: false };
    s = applyEvent(s, { id: 1, type: 'status', data: { message: 'Gathering context…' } });
    expect(s.status).toBe('Gathering context…');
    s = applyEvent(s, { id: 2, type: 'text', data: { delta: 'Let me ' } });
    s = applyEvent(s, { id: 3, type: 'text', data: { delta: 'look.' } });
    s = applyEvent(s, { id: 4, type: 'tool_start', data: { id: 'c', name: 'compile', activity: 'Compiling…' } });
    expect(s.items[1]).toMatchObject({ kind: 'tool', running: true });
    s = applyEvent(s, { id: 5, type: 'tool_end', data: { id: 'c', ok: false, summary: 'Compilation failed with 2 errors' } });
    s = applyEvent(s, { id: 6, type: 'text', data: { delta: 'Two errors.' } });
    s = applyEvent(s, { id: 7, type: 'done', data: { status: 'done' } });
    expect(s.items.map((i) => i.kind)).toEqual(['assistant', 'tool', 'assistant']);
    expect(s.items[0]).toMatchObject({ text: 'Let me look.' });
    expect(s.items[1]).toMatchObject({ running: false, ok: false });
    expect(s.done).toBe(true);
  });
});
