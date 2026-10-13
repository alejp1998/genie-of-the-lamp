import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type AssistantSession, type EditorContext, gateway, type GatewayConfig, RUN_EVENT_TYPES, type SessionDetail } from './api';
import { applyEvent, buildTranscript, type Item, type LiveState } from './transcript';

const lastSessionKey = (projectId: string) => `aldine.assistant.session.${projectId}`;

function readLast(projectId: string): string | null {
  try { return localStorage.getItem(lastSessionKey(projectId)); } catch { return null; }
}
function writeLast(projectId: string, id: string | null) {
  try {
    if (id) localStorage.setItem(lastSessionKey(projectId), id);
    else localStorage.removeItem(lastSessionKey(projectId));
  } catch { /* storage may be unavailable */ }
}

export interface AssistantState {
  sessions: AssistantSession[];
  session: AssistantSession | null;
  items: Item[];
  live: LiveState | null;
  running: boolean;
  error: string | null;
  loading: boolean;
  select(id: string | null): void;
  send(text: string, ctx: EditorContext, model?: string): Promise<boolean>;
  cancel(): void;
  setVisibility(v: 'private' | 'project'): Promise<void>;
  rename(title: string): Promise<void>;
  remove(): Promise<void>;
  dismissError(): void;
}

export function useAssistant(projectId: string, config: GatewayConfig | null): AssistantState {
  const [sessions, setSessions] = useState<AssistantSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const streamRef = useRef<EventSource | null>(null);
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = sessionId;

  const closeStream = useCallback(() => {
    streamRef.current?.close();
    streamRef.current = null;
  }, []);

  const loadSessions = useCallback(async () => {
    const { sessions } = await gateway.sessions(projectId);
    setSessions(sessions);
    return sessions;
  }, [projectId]);

  const loadDetail = useCallback(async (id: string) => {
    const d = await gateway.session(id);
    if (sessionRef.current === id) setDetail(d);
    return d;
  }, []);

  const follow = useCallback((sid: string, runId: string, userText: string) => {
    closeStream();
    setLive({ runId, userText, items: [], status: 'Starting…', done: false });
    const es = gateway.events(runId);
    streamRef.current = es;
    let finished = false;
    for (const type of RUN_EVENT_TYPES) {
      es.addEventListener(type, (ev) => {
        const e = { id: Number((ev as MessageEvent).lastEventId), type, data: JSON.parse((ev as MessageEvent).data) };
        setLive((s) => (s && s.runId === runId ? applyEvent(s, e) : s));
        if (type === 'done') {
          finished = true;
          es.close();
          if (streamRef.current === es) streamRef.current = null;
          // The stored transcript is authoritative once the run ends; drop the live copy after it loads.
          Promise.all([loadDetail(sid), loadSessions()])
            .catch(() => {})
            .finally(() => setLive((s) => (s && s.runId === runId ? null : s)));
        }
      });
    }
    es.onerror = () => {
      // EventSource retries on its own (resuming with Last-Event-ID); only a closed stream needs a reload.
      if (!finished && es.readyState === EventSource.CLOSED) {
        loadDetail(sid).then((d) => { if (!d.activeRunId) setLive(null); }).catch(() => {});
      }
    };
  }, [closeStream, loadDetail, loadSessions]);

  const select = useCallback((id: string | null) => {
    closeStream();
    setLive(null);
    setDetail(null);
    setSessionId(id);
    writeLast(projectId, id);
    if (!id) return;
    setLoading(true);
    gateway.session(id)
      .then((d) => {
        if (sessionRef.current !== id) return;
        setDetail(d);
        if (d.activeRunId) {
          const um = d.messages.find((m) => m.runId === d.activeRunId && m.role === 'user');
          const text = um?.blocks.filter((b) => b.type === 'text' && !(b as { meta?: string }).meta).map((b) => (b as { text: string }).text).join('\n') ?? '';
          follow(id, d.activeRunId, text);
        }
      })
      .catch((e) => { setError(e.message); setSessionId(null); writeLast(projectId, null); })
      .finally(() => setLoading(false));
  }, [closeStream, follow, projectId]);

  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    loadSessions()
      .then((list) => {
        if (cancelled) return;
        const last = readLast(projectId);
        const pick = list.find((s) => s.id === last) ?? null;
        if (pick) select(pick.id);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; closeStream(); };
  }, [config, projectId]);

  const send = useCallback(async (text: string, ctx: EditorContext, model?: string) => {
    setError(null);
    try {
      let sid = sessionRef.current;
      if (!sid) {
        const { session } = await gateway.createSession(projectId);
        sid = session.id;
        setSessionId(sid);
        sessionRef.current = sid;
        writeLast(projectId, sid);
        setDetail({ session, messages: [], runs: [], activity: [], activeRunId: null });
        setSessions((list) => [session, ...list]);
      }
      const { run } = await gateway.send(sid, text, ctx, model);
      follow(sid, run.id, text);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }, [follow, projectId]);

  const cancel = useCallback(() => {
    if (live && !live.done) gateway.cancel(live.runId).catch((e) => setError(e.message));
  }, [live]);

  const setVisibility = useCallback(async (visibility: 'private' | 'project') => {
    if (!sessionId) return;
    try {
      const { session } = await gateway.updateSession(sessionId, { visibility });
      setDetail((d) => (d ? { ...d, session } : d));
      setSessions((list) => list.map((s) => (s.id === session.id ? session : s)));
    } catch (e) { setError((e as Error).message); }
  }, [sessionId]);

  const rename = useCallback(async (title: string) => {
    if (!sessionId) return;
    try {
      const { session } = await gateway.updateSession(sessionId, { title });
      setDetail((d) => (d ? { ...d, session } : d));
      setSessions((list) => list.map((s) => (s.id === session.id ? session : s)));
    } catch (e) { setError((e as Error).message); }
  }, [sessionId]);

  const remove = useCallback(async () => {
    if (!sessionId) return;
    try {
      await gateway.deleteSession(sessionId);
      setSessions((list) => list.filter((s) => s.id !== sessionId));
      select(null);
    } catch (e) { setError((e as Error).message); }
  }, [select, sessionId]);

  const items = useMemo(
    () => (detail ? buildTranscript(detail.messages, detail.activity, live?.runId ?? null) : []),
    [detail, live?.runId],
  );

  return {
    sessions,
    session: detail?.session ?? null,
    items,
    live,
    running: !!live && !live.done,
    error,
    loading,
    select,
    send,
    cancel,
    setVisibility,
    rename,
    remove,
    dismissError: () => setError(null),
  };
}
