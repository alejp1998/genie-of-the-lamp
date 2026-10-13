import { useState } from 'react';
import Modal from './Modal';
import ReadOnlyCode from './ReadOnlyCode';
import { isMac } from '../platform';

/** Inline composer for a new review comment (replaces the old window.prompt flow). */
export default function CommentComposer({ quote, context, file, onSubmit, onClose }: {
  quote: string;
  /** The rest of the selection's first and last lines, to show it in place. */
  context?: { before: string; after: string; fromLine: number };
  file?: string;
  onSubmit(body: string, suggestion?: string): void;
  onClose(): void;
}) {
  // Full lines by default: a comment is read against the sentence around it.
  const [selectionOnly, setSelectionOnly] = useState(false);
  const before = selectionOnly ? (context?.before ? '…' : '') : context?.before ?? '';
  const after = selectionOnly ? (context?.after ? '…' : '') : context?.after ?? '';
  const shown = before + quote + after;
  const [body, setBody] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    onSubmit(body.trim(), suggesting && suggestion ? suggestion : undefined);
  };

  return (
    <Modal onClose={onClose} label="Add a comment" width={Math.min(960, Math.round(window.innerWidth * 0.92))} testId="comment-composer">
      <div>
        <div className="composer__head">
          <h2>Add a comment</h2>
          {file && <span className="composer__file">{file}</span>}
          <span className="toolbar__spacer" />
          {context && (context.before || context.after) && (
            <div className="seg" role="tablist" aria-label="Show">
              <button role="tab" aria-selected={!selectionOnly} className={`seg__btn${!selectionOnly ? ' seg__btn--active' : ''}`} onClick={() => setSelectionOnly(false)} data-testid="composer-full-lines">Full lines</button>
              <button role="tab" aria-selected={selectionOnly} className={`seg__btn${selectionOnly ? ' seg__btn--active' : ''}`} onClick={() => setSelectionOnly(true)} data-testid="composer-selection-only">Selection only</button>
            </div>
          )}
        </div>
        {context ? (
          <div className="composer__preview" data-testid="composer-preview">
            <ReadOnlyCode text={shown} firstLine={context.fromLine} mark={{ from: before.length, to: before.length + quote.length }} testId="composer-code" />
          </div>
        ) : (
          <blockquote className="composer__quote" title={quote}>{quote}</blockquote>
        )}
        <textarea
          className="input composer__body"
          placeholder="Your comment…"
          value={body}
          data-testid="comment-body"
          autoFocus
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); if (e.key === 'Escape') onClose(); }}
        />

        {suggesting ? (
          <textarea
            className="input composer__body"
            placeholder="Suggested replacement for the selected text"
            value={suggestion}
            data-testid="comment-suggestion"
            onChange={(e) => setSuggestion(e.target.value)}
          />
        ) : (
          <button className="btn btn--ghost btn--small composer__suggest" onClick={() => setSuggesting(true)} data-testid="comment-suggest-toggle">
            + Suggest a replacement
          </button>
        )}

        <div className="modal__row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={submit} disabled={!body.trim() || busy} data-testid="comment-submit">
            {busy ? '…' : 'Comment'} <span className="composer__hint">{isMac ? '⌘⏎' : 'Ctrl+Enter'}</span>
          </button>
        </div>
      </div>
    </Modal>
  );
}
