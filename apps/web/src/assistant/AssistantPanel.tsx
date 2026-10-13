import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDialogs } from '../components/Dialogs';
import { IconSpark, IconX } from '../components/Icons';
import { useExitGhost } from '../exitGhost';
import type { EditorContext, GatewayConfig } from './api';
import Markdown from './Markdown';
import type { Item } from './transcript';
import { useAssistant } from './useAssistant';
import './assistant.css';

interface Props {
  projectId: string;
  config: GatewayConfig;
  /** Snapshot of what the user is looking at; read when a message is sent. */
  getContext(): EditorContext;
  onClose(): void;
}

const SUGGESTIONS = [
  'Why does the document fail to compile?',
  'Summarize the open file in three sentences.',
  'Find terms used inconsistently across sections.',
];

function contextLabel(ctx: EditorContext): string {
  if (ctx.selection) {
    const n = ctx.selection.toLine - ctx.selection.fromLine + 1;
    return `Selection · ${n} line${n === 1 ? '' : 's'} in ${ctx.openFile ?? 'the open file'}`;
  }
  if (ctx.openFile) return `${ctx.openFile}${ctx.cursor ? ` · line ${ctx.cursor.line}` : ''}`;
  return `Branch ${ctx.branch}`;
}

function relTime(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

function pretty(v: unknown): string {
  if (typeof v === 'string') {
    try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; }
  }
  return JSON.stringify(v, null, 2);
}

function ToolLine({ item }: { item: Extract<Item, { kind: 'tool' }> }) {
  const state = item.running ? 'busy' : item.ok === false ? 'error' : 'ok';
  return (
    <details className="assistant__tool" data-testid="assistant-tool" data-state={state}>
      <summary>
        <span className={`dot dot--${state}`} aria-hidden="true" />
        <span className="assistant__tool-text">{item.running || !item.summary ? item.activity : item.summary}</span>
      </summary>
      <div className="assistant__details">
        <div className="assistant__details-label">{item.name}</div>
        {item.input !== undefined && <pre>{pretty(item.input)}</pre>}
        {item.output && <><div className="assistant__details-label">Result</div><pre>{pretty(item.output)}</pre></>}
      </div>
    </details>
  );
}

function Transcript({ items }: { items: Item[] }) {
  return (
    <>
      {items.map((it) => {
        if (it.kind === 'user') return <div key={it.key} className="assistant__msg assistant__msg--user" data-testid="assistant-user-msg">{it.text}</div>;
        if (it.kind === 'assistant') return <div key={it.key} className="assistant__msg assistant__msg--agent" data-testid="assistant-reply"><Markdown text={it.text} /></div>;
        if (it.kind === 'tool') return <ToolLine key={it.key} item={it} />;
        return <div key={it.key} className={`assistant__notice assistant__notice--${it.level}`} role="status">{it.message}</div>;
      })}
    </>
  );
}

export default function AssistantPanel({ projectId, config, getContext, onClose }: Props) {
  const a = useAssistant(projectId, config);
  const dialogs = useDialogs();
  const [text, setText] = useState('');
  const [model, setModel] = useState(config.defaultModel);
  const [ctx, setCtx] = useState<EditorContext>(() => getContext());
  const [menu, setMenu] = useState<null | 'sessions' | 'actions'>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const leave = useExitGhost();

  // The context chip follows the editor while the panel is open.
  useEffect(() => {
    const t = setInterval(() => setCtx(getContext()), 1000);
    return () => clearInterval(t);
  }, [getContext]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => { if (!headerRef.current?.contains(e.target as Node)) setMenu(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', key); };
  }, [menu]);

  // Follow the stream to the bottom unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [a.items, a.live]);

  const session = a.session;
  const readOnly = !!session && !session.isOwner;
  const mine = a.sessions.filter((s) => s.isOwner);
  const shared = a.sessions.filter((s) => !s.isOwner);

  const submit = async (value = text) => {
    const v = value.trim();
    if (!v || a.running || readOnly) return;
    const snapshot = getContext();
    setCtx(snapshot);
    stick.current = true;
    if (await a.send(v, snapshot, model !== config.defaultModel ? model : undefined)) setText('');
  };

  const empty = !session && !a.live && !a.loading;

  return (
    <aside className="pane assistant" data-testid="assistant-panel" aria-label={`${config.agentLabel} assistant`}>
      <div className="pane__header assistant__header" ref={headerRef}>
        <span className="assistant__mark" aria-hidden="true"><IconSpark /></span>
        <button
          className="assistant__title"
          onClick={() => setMenu(menu === 'sessions' ? null : 'sessions')}
          aria-haspopup="menu"
          aria-expanded={menu === 'sessions'}
          data-testid="assistant-session-menu"
          title="Switch chat"
        >
          <span className="assistant__title-text">{session ? session.title : 'Assistant'}</span>
          {session?.visibility === 'project' && <span className="assistant__chip" data-testid="assistant-shared-chip">Shared</span>}
          <span className="assistant__caret" aria-hidden="true">▾</span>
        </button>
        <span className="toolbar__spacer" />
        <button className="btn btn--ghost btn--small" onClick={() => { a.select(null); setMenu(null); inputRef.current?.focus(); }} data-testid="assistant-new-chat" title="Start a new chat">New chat</button>
        {session?.isOwner && (
          <button className="btn btn--ghost btn--small" onClick={() => setMenu(menu === 'actions' ? null : 'actions')} aria-haspopup="menu" aria-expanded={menu === 'actions'} aria-label="Chat options" data-testid="assistant-actions">⋯</button>
        )}
        <button className="btn btn--ghost btn--small" onClick={onClose} aria-label="Close the assistant" title="Close the assistant" data-testid="assistant-close"><IconX /></button>

        {menu === 'sessions' && (
          <div ref={leave} className="menu assistant__menu" role="menu" data-testid="assistant-session-list">
            {!a.sessions.length && <div className="menu__label">No chats yet</div>}
            {mine.length > 0 && <div className="menu__label">Your chats</div>}
            {mine.map((s) => (
              <button key={s.id} role="menuitem" className="menu__item assistant__menu-item" onClick={() => { a.select(s.id); setMenu(null); }} data-testid={`assistant-session-${s.id}`}>
                <span className="assistant__menu-title">{s.title}</span>
                <span className="menu__hint">{s.visibility === 'project' ? 'Shared · ' : ''}{relTime(s.updatedAt)}</span>
              </button>
            ))}
            {shared.length > 0 && <><div className="menu__sep" /><div className="menu__label">Shared with the project</div></>}
            {shared.map((s) => (
              <button key={s.id} role="menuitem" className="menu__item assistant__menu-item" onClick={() => { a.select(s.id); setMenu(null); }} data-testid={`assistant-session-${s.id}`}>
                <span className="assistant__menu-title">{s.title}</span>
                <span className="menu__hint">{s.ownerName} · {relTime(s.updatedAt)}</span>
              </button>
            ))}
          </div>
        )}
        {menu === 'actions' && session && (
          <div ref={leave} className="menu assistant__menu assistant__menu--right" role="menu">
            <button role="menuitem" className="menu__item" data-testid="assistant-share-toggle" onClick={() => { setMenu(null); a.setVisibility(session.visibility === 'project' ? 'private' : 'project'); }}>
              {session.visibility === 'project' ? 'Make private' : 'Share with project collaborators'}
            </button>
            <button role="menuitem" className="menu__item" onClick={async () => {
              setMenu(null);
              const t = (await dialogs.prompt({ title: 'Rename chat', value: session.title, confirmLabel: 'Rename' }))?.trim();
              if (t && t !== session.title) a.rename(t);
            }}>Rename…</button>
            <div className="menu__sep" />
            <button role="menuitem" className="menu__item" data-testid="assistant-delete" onClick={async () => {
              setMenu(null);
              if (await dialogs.confirm({ title: `Delete “${session.title}”?`, body: 'The chat is removed for everyone it was shared with. Changes already committed stay in the project history.', confirmLabel: 'Delete chat', danger: true })) a.remove();
            }}>Delete chat…</button>
          </div>
        )}
      </div>

      {readOnly && session && (
        <div className="assistant__banner" data-testid="assistant-readonly">Shared by {session.ownerName}. You can read this chat but not continue it.</div>
      )}

      <div
        className="assistant__body"
        ref={bodyRef}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
        data-testid="assistant-transcript"
      >
        {empty && (
          <div className="assistant__empty" data-testid="assistant-empty">
            <p>Ask about this project. The assistant can read and search files, compile, and explain errors. It does not change your files.</p>
            <div className="assistant__suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="assistant__suggestion" onClick={() => submit(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        <Transcript items={a.items} />
        {a.live && (
          <>
            {a.live.userText && (
              <div className="assistant__msg assistant__msg--user" data-testid="assistant-user-msg">{a.live.userText}</div>
            )}
            <Transcript items={a.live.items} />
            {a.running && (
              <div className="assistant__status" data-testid="assistant-thinking">
                <span className="dot dot--busy" aria-hidden="true" /> {a.live.status ?? 'Thinking…'}
              </div>
            )}
          </>
        )}
      </div>

      {a.error && (
        <div className="assistant__notice assistant__notice--error assistant__error" role="alert" data-testid="assistant-error">
          <span>{a.error}</span>
          <button className="btn btn--ghost btn--small" onClick={a.dismissError} aria-label="Dismiss">×</button>
        </div>
      )}

      {!readOnly && (
        <form className="assistant__composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div className="assistant__context" title="Sent with your message so the assistant knows where you are" data-testid="assistant-context">
            {contextLabel(ctx)}
          </div>
          <textarea
            ref={inputRef}
            className="input assistant__input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
            }}
            placeholder={`Ask ${config.agentLabel}…`}
            rows={3}
            maxLength={config.limits.maxMessageChars}
            aria-label="Message the assistant"
            data-testid="assistant-input"
          />
          <div className="assistant__row">
            {config.models.length > 1 ? (
              <select className="fmt__select" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model" data-testid="assistant-model">
                {config.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            ) : (
              <span className="assistant__hint">{config.models[0]?.label}</span>
            )}
            <span className="toolbar__spacer" />
            {a.running ? (
              <button type="button" className="btn btn--small" onClick={a.cancel} data-testid="assistant-stop">Stop</button>
            ) : (
              <button type="submit" className="btn btn--primary btn--small" disabled={!text.trim()} data-testid="assistant-send">Send</button>
            )}
          </div>
        </form>
      )}
    </aside>
  );
}
