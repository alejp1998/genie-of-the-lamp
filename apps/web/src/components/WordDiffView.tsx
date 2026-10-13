import { useState } from 'react';
import { patchBlocks, type Piece } from './wordDiff';

/** Unchanged text longer than this inside a changed paragraph is trimmed to some context on each side. */
const KEEP = 90;

function Same({ text, first, last }: { text: string; first: boolean; last: boolean }) {
  const [open, setOpen] = useState(false);
  const limit = first || last ? KEEP : KEEP * 2;
  if (open || text.length <= limit + 20) return <span>{text}</span>;
  // Cut on word boundaries so the context reads as words.
  const head = first ? '' : text.slice(0, KEEP).replace(/\S*$/, '');
  const tail = last ? '' : text.slice(text.length - KEEP).replace(/^\S*/, '');
  return (
    <span>
      {head}
      <button className="wdiff__more" onClick={() => setOpen(true)} title="Show the unchanged text" data-testid="word-diff-more">…</button>
      {tail}
    </span>
  );
}

function Change({ pieces }: { pieces: Piece[] }) {
  return (
    <div className="wdiff__change" data-testid="word-diff-change">
      {pieces.map((p, k) => (p.op === 'same'
        ? <Same key={k} text={p.text} first={k === 0} last={k === pieces.length - 1} />
        : p.op === 'del'
          ? <del key={k} className="wdiff__del">{p.text}</del>
          : <ins key={k} className="wdiff__ins">{p.text}</ins>))}
    </div>
  );
}

/**
 * A unified patch shown the way an author reads a review: unchanged text
 * plain, deleted words struck through, inserted words marked, inside the
 * paragraph rather than as a removed line and an added line.
 */
export default function WordDiffView({ patch }: { patch: string }) {
  const blocks = patchBlocks(patch);
  if (!blocks.length) return <p className="wdiff__empty">No changes.</p>;
  return (
    <div className="wdiff" data-testid="word-diff">
      {blocks.map((b, i) => {
        if (b.kind === 'file') return <div key={i} className="wdiff__file">{b.text}</div>;
        if (b.kind === 'hunk') return <div key={i} className="wdiff__hunk" aria-hidden="true">⋯</div>;
        if (b.kind === 'context') return <div key={i} className="wdiff__ctx">{b.text || ' '}</div>;
        if (!b.pieces) {
          return (
            <div key={i} className="wdiff__change">
              {b.removed && <div className="wdiff__line wdiff__line--del">{b.removed}</div>}
              {b.added && <div className="wdiff__line wdiff__line--ins">{b.added}</div>}
            </div>
          );
        }
        return <Change key={i} pieces={b.pieces} />;
      })}
    </div>
  );
}
