import type { ChatMessage, RunEvent } from './api';

export type Item =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'assistant'; key: string; text: string }
  | { kind: 'tool'; key: string; id: string; name: string; activity: string; summary?: string; ok?: boolean; running: boolean; input?: unknown; output?: string }
  | { kind: 'notice'; key: string; level: 'warn' | 'error'; message: string };

const userText = (m: ChatMessage) => m.blocks
  .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && !(b as { meta?: string }).meta)
  .map((b) => b.text).join('\n\n');

/**
 * Stored history → what the panel shows. Tool calls get the gateway's
 * human-readable activity line and outcome; notices and errors land after
 * the last message of the run they belong to. Messages of `skipRunId` (the
 * live run) are left to the live view.
 */
export function buildTranscript(messages: ChatMessage[], activity: RunEvent[], skipRunId: string | null = null): Item[] {
  const starts = new Map<string, any>();
  const ends = new Map<string, any>();
  const notices = new Map<string, RunEvent[]>();
  for (const e of activity) {
    if (e.type === 'tool_start') starts.set(e.data.id, e.data);
    else if (e.type === 'tool_end') ends.set(e.data.id, e.data);
    else if (e.type === 'notice' || e.type === 'run_error') {
      const list = notices.get(e.runId) ?? [];
      list.push(e);
      notices.set(e.runId, list);
    }
  }
  const items: Item[] = [];
  const tools = new Map<string, Extract<Item, { kind: 'tool' }>>();
  const flushNotices = (runId: string | null) => {
    if (!runId) return;
    for (const n of notices.get(runId) ?? []) {
      items.push({ kind: 'notice', key: `n${n.id}`, level: n.type === 'run_error' ? 'error' : n.data.level === 'error' ? 'error' : 'warn', message: n.data.message });
    }
    notices.delete(runId);
  };

  let prevRun: string | null = null;
  for (const m of messages) {
    if (skipRunId && m.runId === skipRunId) continue;
    if (m.runId !== prevRun) { flushNotices(prevRun); prevRun = m.runId; }
    if (m.role === 'user') {
      for (const b of m.blocks) {
        if (b.type !== 'tool_result') continue;
        const t = tools.get(b.id);
        if (t) { t.output = b.content; t.ok = t.ok ?? !b.isError; t.running = false; }
      }
      const text = userText(m);
      if (text) items.push({ kind: 'user', key: `m${m.id}`, text });
      continue;
    }
    m.blocks.forEach((b, i) => {
      if (b.type === 'text' && b.text.trim()) items.push({ kind: 'assistant', key: `m${m.id}-${i}`, text: b.text });
      else if (b.type === 'tool_call') {
        const s = starts.get(b.id);
        const e = ends.get(b.id);
        const item: Extract<Item, { kind: 'tool' }> = {
          kind: 'tool', key: `t${b.id}`, id: b.id, name: b.name,
          activity: s?.activity ?? b.name, summary: e?.summary, ok: e ? !!e.ok : undefined,
          running: false, input: s?.input ?? b.input,
        };
        tools.set(b.id, item);
        items.push(item);
      }
    });
  }
  flushNotices(prevRun);
  return items;
}

export interface LiveState {
  runId: string;
  userText: string;
  items: Item[];
  status: string | null;
  done: boolean;
}

/** Folds one SSE event into the live view of a running request. */
export function applyEvent(s: LiveState, e: { id: number; type: string; data: any }): LiveState {
  const items = [...s.items];
  const last = items[items.length - 1];
  switch (e.type) {
    case 'status':
      return { ...s, status: e.data.message };
    case 'text':
      if (last?.kind === 'assistant') items[items.length - 1] = { ...last, text: last.text + e.data.delta };
      else items.push({ kind: 'assistant', key: `live${e.id}`, text: e.data.delta });
      return { ...s, items, status: null };
    case 'tool_start':
      items.push({ kind: 'tool', key: `t${e.data.id}`, id: e.data.id, name: e.data.name, activity: e.data.activity, running: true, input: e.data.input });
      return { ...s, items, status: null };
    case 'tool_end': {
      const i = items.findIndex((it) => it.kind === 'tool' && it.id === e.data.id);
      if (i >= 0) items[i] = { ...(items[i] as Extract<Item, { kind: 'tool' }>), running: false, ok: !!e.data.ok, summary: e.data.summary, output: e.data.output };
      return { ...s, items };
    }
    case 'notice':
    case 'run_error':
      items.push({ kind: 'notice', key: `n${e.id}`, level: e.type === 'run_error' ? 'error' : 'warn', message: e.data.message });
      return { ...s, items };
    case 'done':
      return { ...s, done: true, status: null };
    default:
      return s;
  }
}
