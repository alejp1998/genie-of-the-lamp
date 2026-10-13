import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDialogs } from '../components/Dialogs';
import { IconSpark, IconX } from '../components/Icons';
import { openVirtualDoc } from '../components/VirtualDocs';
import { useExitGhost } from '../exitGhost';
import type { EditorContext, GatewayConfig } from './api';
import Composer, { Chips, type ComposerHandle, type Pending, type Prefill } from './Composer';
import Markdown from './Markdown';
import ProposalCard from './ProposalCard';
import Sources from './Sources';
import { PLACEMENTS, type Placement } from './placement';
import type { Item } from './transcript';
import { type AssistantState, useAssistant } from './useAssistant';
import './assistant.css';

interface Props {
  projectId: string;
  config: GatewayConfig;
  /** Snapshot of what the user is looking at; read when a message is sent. */
  getContext(): EditorContext;
  onClose(): void;
  onShowHistory?(): void;
  /** Project text files for @ references. */
  getFiles(): string[];
  /** A prompt sent from an editor selection action. */
  prefill: Prefill | null;
  /** Where the panel lives, and how to move it. */
  placement?: Placement;
  onPlace?(p: Placement): void;
}

const SUGGESTIONS = [
  'Why does the document fail to compile?',
  'Summarize the open file in three sentences.',
  'Find terms used inconsistently across sections.',
  'Handle the open review comments one by one.',
];

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

const citePrompt = (s: { title: string; doi?: string | null; arxivId?: string | null }) =>
  `Add “${s.title}” (${s.doi ? `doi:${s.doi}` : `arXiv:${s.arxivId}`}) to the bibliography and cite it where it supports the text. Check first that it really supports the sentence you cite it for.`;

function openToolOutput(item: Extract<Item, { kind: 'tool' }>) {
  let parsed: any = null;
  try { parsed = JSON.parse(item.output ?? ''); } catch { /* not JSON */ }
  // Pages and papers the assistant read open as their text, not as JSON.
  const read = item.name === 'fetch_url' ? parsed : item.name === 'get_paper' ? parsed?.full_text : null;
  if (typeof read?.text === 'string') {
    openVirtualDoc({ id: `tool:${item.id}`, title: `${parsed.title ?? read.url ?? item.name} (as read)`, kind: 'text', content: `${read.url ?? ''}\n\n${read.text}` });
    return;
  }
  const isFile = item.name === 'read_file' && typeof parsed?.content === 'string';
  openVirtualDoc({
    id: `tool:${item.id}`,
    title: isFile ? `${parsed.path} (as read${parsed.from_line ? `, lines ${parsed.from_line}–${parsed.to_line}` : ''})` : `${item.name} result`,
    kind: isFile ? 'latex' : 'text',
    content: isFile ? parsed.content : pretty(item.output),
  });
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
        <div className="assistant__details-label">
          {item.name}
          {item.output && <button className="assistant__link" onClick={() => openToolOutput(item)} data-testid="assistant-tool-open">Open in editor</button>}
        </div>
        {item.input !== undefined && <pre>{pretty(item.input)}</pre>}
        {item.images?.map((src, i) => (
          <button key={src} className="assistant__tool-img" onClick={() => openVirtualDoc({ id: `toolimg:${item.id}:${i}`, title: `${String((item.input as { path?: string })?.path ?? 'Image')} (as viewed)`, kind: 'image', src })} title="Open in the editor area">
            <img src={src} alt="" />
          </button>
        ))}
        {item.output && <><div className="assistant__details-label">Result</div><pre>{pretty(item.output)}</pre></>}
      </div>
    </details>
  );
}

interface CardHooks {
  proposals: AssistantState['proposals'];
  canDecide: boolean;
  accept: AssistantState['accept'];
  reject: AssistantState['reject'];
  ask(text: string): void;
  onShowHistory?(): void;
}

function Transcript({ items, cards }: { items: Item[]; cards: CardHooks }) {
  return (
    <>
      {items.map((it) => {
        const proposal = it.kind === 'tool' && it.name === 'propose_patch' ? cards.proposals.get(it.id) : undefined;
        if (proposal) {
          return (
            <ProposalCard
              key={it.key}
              proposal={proposal}
              canDecide={cards.canDecide}
              onAccept={(parts) => cards.accept(proposal.id, parts)}
              onReject={() => cards.reject(proposal.id)}
              onAsk={cards.ask}
              onShowHistory={cards.onShowHistory}
            />
          );
        }
        if (it.kind === 'user') {
          return (
            <div key={it.key} className="assistant__user">
              {it.text && <div className="assistant__msg assistant__msg--user" data-testid="assistant-user-msg">{it.text}</div>}
              <Chips items={(it.attachments ?? []).map((a, i) => ({ key: `${it.key}-${i}`, a }))} />
              {it.context && (
                <button className="assistant__link assistant__ctx-link" onClick={() => openVirtualDoc({ id: `ctx:${it.key}`, title: 'Context sent with the message', kind: 'text', content: it.context! })} data-testid="assistant-open-context">
                  Context sent
                </button>
              )}
            </div>
          );
        }
        if (it.kind === 'assistant') return <div key={it.key} className="assistant__msg assistant__msg--agent" data-testid="assistant-reply"><Markdown text={it.text} /></div>;
        if (it.kind === 'tool') return <ToolLine key={it.key} item={it} />;
        if (it.kind === 'sources') return <Sources key={it.key} sources={it.sources} onCite={cards.canDecide ? (s) => cards.ask(citePrompt(s)) : undefined} />;
        return <div key={it.key} className={`assistant__notice assistant__notice--${it.level}`} role="status">{it.message}</div>;
      })}
    </>
  );
}

/** Region of a little window the panel occupies, per placement. */
const LAYOUT_ICON: Record<Placement, string> = {
  below: 'M2 7.5h4.5v4H2z',
  tab: 'M2 2.5h4.5v9H2z',
  right: 'M10.5 2.5H14v9h-3.5z',
};

function LayoutSwitch({ placement, onPlace }: { placement: Placement; onPlace(p: Placement): void }) {
  return (
    <span className="assistant__layout" role="radiogroup" aria-label="Where the assistant sits">
      {PLACEMENTS.map((p) => (
        <button
          key={p.id}
          role="radio"
          aria-checked={placement === p.id}
          className={`assistant__layout-btn${placement === p.id ? ' assistant__layout-btn--on' : ''}`}
          onClick={() => onPlace(p.id)}
          title={p.label}
          aria-label={p.label}
          data-testid={`assistant-place-${p.id}`}
        >
          <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
            <rect x="1" y="1.5" width="14" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <path d={LAYOUT_ICON[p.id]} fill="currentColor" />
          </svg>
        </button>
      ))}
    </span>
  );
}

export default function AssistantPanel({ projectId, config, getContext, onClose, onShowHistory, getFiles, prefill, placement, onPlace }: Props) {
  const a = useAssistant(projectId, config);
  const dialogs = useDialogs();
  const [model, setModel] = useState(config.defaultModel);
  const [ctx, setCtx] = useState<EditorContext>(() => getContext());
  const [menu, setMenu] = useState<null | 'sessions' | 'actions'>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const composer = useRef<ComposerHandle>(null);
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
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

  const send = async (text: string, pending: Pending[] = []) => {
    if (a.running || readOnly) return false;
    const snapshot = getContext();
    setCtx(snapshot);
    stick.current = true;
    return a.send(text, snapshot, model !== config.defaultModel ? model : undefined, pending.map((p) => p.attachment), pending.map((p) => p.preview));
  };

  const empty = !session && !a.live && !a.loading;
  const cards: CardHooks = { proposals: a.proposals, canDecide: !readOnly, accept: a.accept, reject: a.reject, ask: (t) => void send(t), onShowHistory };

  return (
    <aside
      className={`pane assistant${dropping ? ' assistant--drop' : ''}`}
      data-testid="assistant-panel"
      aria-label={`${config.agentLabel} assistant`}
      onDragEnter={(e) => { if (!readOnly && e.dataTransfer.types.includes('Files')) { dragDepth.current++; setDropping(true); } }}
      onDragOver={(e) => { if (!readOnly && e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDropping(false); } }}
      onDrop={(e) => {
        dragDepth.current = 0;
        setDropping(false);
        if (readOnly || !e.dataTransfer.files.length) return;
        e.preventDefault();
        void composer.current?.addFiles(e.dataTransfer.files);
      }}
    >
      {dropping && <div className="assistant__dropzone" aria-hidden="true">Drop text files, PDFs or images to attach</div>}
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
        <button className="btn btn--ghost btn--small" onClick={() => { a.select(null); setMenu(null); }} data-testid="assistant-new-chat" title="Start a new chat">New chat</button>
        {onPlace && placement && <LayoutSwitch placement={placement} onPlace={onPlace} />}
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
        {menu === 'actions' && session?.isOwner && (
          <div ref={leave} className="menu assistant__menu assistant__menu--right" role="menu">
            {session?.isOwner && <>
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
            </>}
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
                <button key={s} className="assistant__suggestion" onClick={() => void send(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        <Transcript items={a.items} cards={cards} />
        {a.live && (
          <>
            <div className="assistant__user">
              {a.live.userText && <div className="assistant__msg assistant__msg--user" data-testid="assistant-user-msg">{a.live.userText}</div>}
              <Chips items={(a.live.userAttachments ?? []).map((att, i) => ({ key: `live-${i}`, a: att }))} />
            </div>
            <Transcript items={a.live.items} cards={cards} />
            {a.live.sources && a.live.sources.length > 0 && <Sources sources={a.live.sources} onCite={!readOnly ? (s) => void send(citePrompt(s)) : undefined} />}
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
        <Composer
          ref={composer}
          config={config}
          ctx={ctx}
          files={getFiles()}
          running={a.running}
          model={model}
          setModel={setModel}
          onSend={send}
          onStop={a.cancel}
          onError={a.showError}
          prefill={prefill}
        />
      )}
    </aside>
  );
}
