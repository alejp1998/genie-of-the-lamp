import { useCallback, useEffect, useState } from 'react';
import DiffView from './DiffView';
import { MediaView } from './FilePreview';
import { IconX } from './Icons';
import ReadOnlyCode from './ReadOnlyCode';

/**
 * Read-only documents that are not project files (pasted text, an
 * assistant's tool output, a proposed diff, an attached screenshot), opened
 * as tabs beside the file being edited. Anything can open one with
 * openVirtualDoc(); the editor page owns the tabs.
 */
export interface VirtualDoc {
  /** Stable per source: opening the same id again just focuses its tab. */
  id: string;
  title: string;
  kind: 'latex' | 'text' | 'diff' | 'image' | 'pdf';
  /** Text, LaTeX or a unified diff. */
  content?: string;
  /** URL for images and PDFs. */
  src?: string;
}

const EVENT = 'aldine:open-doc';
const MAX_TABS = 8;

export function openVirtualDoc(doc: VirtualDoc) {
  window.dispatchEvent(new CustomEvent<VirtualDoc>(EVENT, { detail: doc }));
}

export function useVirtualDocs() {
  const [docs, setDocs] = useState<VirtualDoc[]>([]);
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const open = (e: Event) => {
      const doc = (e as CustomEvent<VirtualDoc>).detail;
      setDocs((list) => {
        const rest = list.filter((d) => d.id !== doc.id);
        return [...rest, doc].slice(-MAX_TABS);
      });
      setActive(doc.id);
    };
    window.addEventListener(EVENT, open);
    return () => window.removeEventListener(EVENT, open);
  }, []);
  const close = useCallback((id: string) => {
    setDocs((list) => list.filter((d) => d.id !== id));
    setActive((a) => (a === id ? null : a));
  }, []);
  /** null = the project file is in front. */
  const current = docs.find((d) => d.id === active) ?? null;
  return { docs, current, show: setActive, close };
}

export function VirtualTabs({ fileLabel, docs, current, onShow, onClose }: {
  fileLabel: string | null;
  docs: VirtualDoc[];
  current: VirtualDoc | null;
  onShow(id: string | null): void;
  onClose(id: string): void;
}) {
  if (!docs.length) return null;
  return (
    <div className="vtabs" role="tablist" aria-label="Open documents" data-testid="virtual-tabs">
      <button role="tab" aria-selected={!current} className={`vtabs__tab${!current ? ' vtabs__tab--active' : ''}`} onClick={() => onShow(null)} data-testid="vtab-file">
        {fileLabel ?? 'Editor'}
      </button>
      {docs.map((d) => (
        <div key={d.id} role="tab" aria-selected={current?.id === d.id} className={`vtabs__tab vtabs__tab--virtual${current?.id === d.id ? ' vtabs__tab--active' : ''}`} data-testid="vtab">
          <button className="vtabs__label" onClick={() => onShow(d.id)} title={d.title}>{d.title}</button>
          <button className="vtabs__close" onClick={() => onClose(d.id)} aria-label={`Close ${d.title}`}><IconX /></button>
        </div>
      ))}
    </div>
  );
}

export function VirtualDocView({ doc }: { doc: VirtualDoc }) {
  const copy = () => { if (doc.content) void navigator.clipboard?.writeText(doc.content).catch(() => {}); };
  return (
    <div className="vdoc" data-testid="virtual-doc" data-kind={doc.kind}>
      <div className="pane__header vdoc__header">
        <span className="statusbar__file">{doc.title}</span>
        <span className="vdoc__badge">Read-only</span>
        <span className="toolbar__spacer" />
        {doc.content && <button className="btn btn--ghost btn--small" onClick={copy}>Copy</button>}
      </div>
      {doc.kind === 'diff' && <div className="vdoc__diff"><DiffView patch={doc.content ?? ''} /></div>}
      {(doc.kind === 'latex' || doc.kind === 'text') && <ReadOnlyCode text={doc.content ?? ''} language={doc.kind === 'latex' ? 'latex' : 'plain'} />}
      {(doc.kind === 'image' || doc.kind === 'pdf') && doc.src && <MediaView src={doc.src} kind={doc.kind} name={doc.title} />}
    </div>
  );
}
