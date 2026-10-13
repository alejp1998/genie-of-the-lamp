import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { openVirtualDoc } from '../components/VirtualDocs';
import type { Attachment, EditorContext, GatewayConfig } from './api';
import { intake, IntakeError } from './fileIntake';
import type { ItemAttachment } from './transcript';

export interface Prefill { text: string; seq: number; withSelection?: boolean; selection?: { text: string; fromLine: number; toLine: number } }

/** Chips the composer shows; `preview` is what the transcript shows until the stored copy loads. */
export interface Pending { id: string; attachment: Attachment; label: string; preview: ItemAttachment }

const MAX_IMAGES = 4;
const MAX_PDFS = 3;
/** Pastes longer than this become an attachment instead of filling the box. */
const PASTE_CHARS = 1500;
const PASTE_LINES = 30;

export const SLASH_COMMANDS: { name: string; hint: string; prompt: string }[] = [
  { name: 'explain', hint: 'Explain the selection or the code at the cursor', prompt: 'Explain the selected text (or the LaTeX around my cursor) in plain words.' },
  { name: 'fix', hint: 'Find why the build fails and propose a fix', prompt: 'The document does not compile. Find the cause and propose the smallest fix.' },
  { name: 'improve', hint: 'Better wording, same meaning and citations', prompt: 'Improve the wording of the selected text without changing its meaning, claims, citations or labels. Propose it as a change.' },
  { name: 'cite', hint: 'Suggest citations from the bibliography', prompt: 'Suggest citations from this project\'s bibliography for the selected text. Use only existing keys and propose the \\cite additions.' },
  { name: 'summarize', hint: 'Summarize the open file', prompt: 'Summarize the open file in one short paragraph.' },
  { name: 'review', hint: 'List unclear sentences, terminology and LaTeX issues', prompt: 'Review this section for unclear sentences, inconsistent terminology and LaTeX problems. List the issues with file and line; do not change anything yet.' },
];

let seq = 0;
const nextId = () => `a${Date.now().toString(36)}${seq++}`;

function contextLabel(ctx: EditorContext): string {
  if (ctx.selection) {
    const n = ctx.selection.toLine - ctx.selection.fromLine + 1;
    return `Selection · ${n} line${n === 1 ? '' : 's'} in ${ctx.openFile ?? 'the open file'}`;
  }
  if (ctx.openFile) return `${ctx.openFile}${ctx.cursor ? ` · line ${ctx.cursor.line}` : ''}`;
  return `Branch ${ctx.branch}`;
}

export function openAttachment(a: ItemAttachment, key: string) {
  if ((a.kind === 'image' || a.kind === 'pdf') && a.src) openVirtualDoc({ id: `att:${key}`, title: a.name, kind: a.kind, src: a.src });
  else openVirtualDoc({ id: `att:${key}`, title: a.kind === 'file' ? `${a.name} (as sent)` : a.name, kind: /\.(tex|sty|cls|bib)$/i.test(a.name) || a.kind === 'file' ? 'latex' : 'text', content: a.text ?? '' });
}

export function Chips({ items, onRemove }: { items: { key: string; a: ItemAttachment }[]; onRemove?(key: string): void }) {
  if (!items.length) return null;
  return (
    <div className="assistant__chips" data-testid="assistant-chips">
      {items.map(({ key, a }) => (
        <span key={key} className={`assistant__chip-att assistant__chip-att--${a.kind}`} data-testid="assistant-attachment">
          <button className="assistant__chip-open" onClick={() => openAttachment(a, key)} title={`Open ${a.name} in the editor area`}>
            {a.kind === 'image' && a.src ? <img src={a.src} alt="" /> : <span className="assistant__chip-icon" aria-hidden="true">{a.kind === 'file' ? '@' : a.kind === 'pdf' ? 'PDF' : '¶'}</span>}
            <span className="assistant__chip-name">{a.name}</span>
          </button>
          {onRemove && <button className="assistant__chip-x" onClick={() => onRemove(key)} aria-label={`Remove ${a.name}`}>×</button>}
        </span>
      ))}
    </div>
  );
}

interface Props {
  config: GatewayConfig;
  ctx: EditorContext;
  files: string[];
  running: boolean;
  model: string;
  setModel(m: string): void;
  onSend(text: string, pending: Pending[]): Promise<boolean>;
  onStop(): void;
  onError(msg: string): void;
  /** A prompt (from a selection action) to put in the box. */
  prefill: Prefill | null;
}

export interface ComposerHandle { addFiles(list: FileList | File[]): Promise<void> }

const Composer = forwardRef<ComposerHandle, Props>(function Composer({ config, ctx, files, running, model, setModel, onSend, onStop, onError, prefill }, ref) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [menu, setMenu] = useState<{ kind: 'file' | 'slash'; query: string; index: number } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pastes = useRef(0);

  const attachSelection = (sel = ctx.selection) => {
    if (!sel) return;
    const name = `${ctx.openFile ?? 'selection'}:${sel.fromLine}${sel.toLine !== sel.fromLine ? `–${sel.toLine}` : ''}`;
    setPending((p) => (p.some((x) => x.label === name) ? p : [...p, { id: nextId(), label: name, attachment: { kind: 'text', name, text: sel.text }, preview: { kind: 'text', name, text: sel.text } }]));
  };

  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    if (prefill.withSelection) attachSelection(prefill.selection ?? ctx.selection);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(prefill.text.length, prefill.text.length); });
  }, [prefill?.seq]); // a new prefill, not every re-render

  const options = useMemo(() => {
    if (!menu) return [];
    const q = menu.query.toLowerCase();
    if (menu.kind === 'slash') return SLASH_COMMANDS.filter((c) => c.name.startsWith(q)).map((c) => ({ id: c.name, label: `/${c.name}`, hint: c.hint }));
    const scored = files
      .map((f) => ({ f, i: f.toLowerCase().indexOf(q), base: f.toLowerCase().split('/').pop()!.startsWith(q) }))
      .filter((x) => !q || x.i >= 0)
      .sort((a, b) => Number(b.base) - Number(a.base) || a.i - b.i || a.f.length - b.f.length);
    return scored.slice(0, 8).map((x) => ({ id: x.f, label: x.f, hint: '' }));
  }, [menu, files]);

  const updateMenu = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const at = /(^|\s)@([\w./-]*)$/.exec(before);
    if (at) { setMenu((m) => ({ kind: 'file', query: at[2], index: m?.kind === 'file' ? Math.min(m.index, 7) : 0 })); return; }
    const slash = /^\/(\w*)$/.exec(before);
    if (slash) { setMenu({ kind: 'slash', query: slash[1], index: 0 }); return; }
    setMenu(null);
  };

  const pick = (id: string) => {
    const el = input.current!;
    const caret = el.selectionStart ?? text.length;
    if (menu?.kind === 'slash') {
      const cmd = SLASH_COMMANDS.find((c) => c.name === id)!;
      setText(cmd.prompt);
      if (/selected text/.test(cmd.prompt) && ctx.selection) attachSelection();
    } else {
      const before = text.slice(0, caret).replace(/@([\w./-]*)$/, '');
      setText(before + text.slice(caret));
      setPending((p) => (p.some((x) => x.attachment.kind === 'file' && x.attachment.path === id) ? p : [...p, { id: nextId(), label: id, attachment: { kind: 'file', path: id }, preview: { kind: 'file', name: id, path: id } }]));
    }
    setMenu(null);
    requestAnimationFrame(() => el.focus());
  };

  const addFiles = async (list: FileList | File[]) => {
    let images = pending.filter((p) => p.attachment.kind === 'image').length;
    let pdfs = pending.filter((p) => p.attachment.kind === 'pdf').length;
    for (const f of Array.from(list)) {
      try {
        const got = await intake(f);
        if (got.attachment.kind === 'image' && ++images > MAX_IMAGES) { onError(`At most ${MAX_IMAGES} images per message.`); continue; }
        if (got.attachment.kind === 'pdf' && ++pdfs > MAX_PDFS) { onError(`At most ${MAX_PDFS} PDFs per message.`); continue; }
        setPending((p) => [...p, { id: nextId(), ...got }]);
      } catch (err) {
        onError(err instanceof IntakeError ? err.message : `Could not attach ${f.name}: ${(err as Error).message}`);
      }
    }
  };
  useImperativeHandle(ref, () => ({ addFiles }));

  const submit = async (value = text) => {
    const v = value.trim();
    if (!v || running) return;
    if (await onSend(v, pending)) { setText(''); setPending([]); setMenu(null); }
  };

  return (
    <form className="assistant__composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="assistant__context-row">
        <span className="assistant__context" title="Sent with your message so the assistant knows where you are" data-testid="assistant-context">{contextLabel(ctx)}</span>
        {ctx.selection && <button type="button" className="assistant__link" onClick={() => attachSelection()} data-testid="assistant-add-selection">Add selection</button>}
      </div>
      <Chips items={pending.map((p) => ({ key: p.id, a: p.preview }))} onRemove={(key) => setPending((p) => p.filter((x) => x.id !== key))} />
      <div className="assistant__input-wrap">
        {menu && options.length > 0 && (
          <div className="menu assistant__mention" role="listbox" data-testid={menu.kind === 'file' ? 'assistant-file-menu' : 'assistant-slash-menu'}>
            {options.map((o, i) => (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={i === menu.index}
                className={`menu__item${i === menu.index ? ' assistant__mention--active' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); pick(o.id); }}
              >
                <span className="assistant__mention-label">{o.label}</span>
                {o.hint && <span className="menu__hint">{o.hint}</span>}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={input}
          className="input assistant__input"
          value={text}
          onChange={(e) => { setText(e.target.value); updateMenu(e.target.value, e.target.selectionStart ?? e.target.value.length); }}
          onKeyDown={(e) => {
            if (menu && options.length) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setMenu({ ...menu, index: (menu.index + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length }); return; }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(options[menu.index].id); return; }
              if (e.key === 'Escape') { e.preventDefault(); setMenu(null); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
          }}
          onPaste={(e) => {
            // Files copied in a file manager or a screenshot tool arrive as files.
            if (e.clipboardData.files.length) { e.preventDefault(); void addFiles(e.clipboardData.files); return; }
            const t = e.clipboardData.getData('text/plain');
            if (t.length > PASTE_CHARS || t.split('\n').length > PASTE_LINES) {
              e.preventDefault();
              const name = `Pasted text ${++pastes.current}`;
              setPending((p) => [...p, { id: nextId(), label: name, attachment: { kind: 'text', name, text: t }, preview: { kind: 'text', name, text: t } }]);
            }
          }}
          placeholder={`Ask ${config.agentLabel}…  @ to reference a file, / for commands`}
          rows={3}
          maxLength={config.limits.maxMessageChars}
          aria-label="Message the assistant"
          data-testid="assistant-input"
        />
      </div>
      <div className="assistant__row">
        <button type="button" className="btn btn--ghost btn--small" onClick={() => fileInput.current?.click()} title="Attach text files, PDFs or images (or paste / drop them)" data-testid="assistant-attach">Attach</button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} />
        {config.models.length > 1 ? (
          <select className="fmt__select" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model" data-testid="assistant-model">
            {config.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        ) : (
          <span className="assistant__hint">{config.models[0]?.label}</span>
        )}
        <span className="toolbar__spacer" />
        {running ? (
          <button type="button" className="btn btn--small" onClick={onStop} data-testid="assistant-stop">Stop</button>
        ) : (
          <button type="submit" className="btn btn--primary btn--small" disabled={!text.trim()} data-testid="assistant-send">Send</button>
        )}
      </div>
    </form>
  );
});

export default Composer;
