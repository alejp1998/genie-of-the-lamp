/**
 * Word-level diff for prose in LaTeX source. A paragraph is often one long
 * source line, so a line diff marks all of it; this marks only the words
 * that changed. Tokens are LaTeX commands, words, runs of whitespace and
 * single punctuation marks.
 */

export type Piece = { op: 'same' | 'del' | 'ins'; text: string };

const TOKEN = /\\[A-Za-z@]+\*?|[\p{L}\p{N}_]+|\s+|[^\s\p{L}\p{N}_]/gu;
/** Past this many token pairs the table gets too big for a click; the caller shows whole lines instead. */
const MAX_CELLS = 4_000_000;

export function tokenize(s: string): string[] {
  return s.match(TOKEN) ?? [];
}

/** null when the inputs are too large to diff word by word. */
export function wordDiff(a: string, b: string): Piece[] | null {
  const x = tokenize(a);
  const y = tokenize(b);
  // Trim the common head and tail: most edits touch a sentence, not the paragraph.
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const xs = x.slice(head, x.length - tail);
  const ys = y.slice(head, y.length - tail);
  const n = xs.length;
  const m = ys.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;

  // LCS lengths, suffix form: L[i][j] = LCS of xs[i..] and ys[j..].
  const L = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[at(i, j)] = xs[i] === ys[j] ? L[at(i + 1, j + 1)] + 1 : Math.max(L[at(i + 1, j)], L[at(i, j + 1)]);
    }
  }
  const out: Piece[] = [];
  const push = (op: Piece['op'], text: string) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text;
    else out.push({ op, text });
  };
  if (head) push('same', x.slice(0, head).join(''));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && xs[i] === ys[j]) { push('same', xs[i]); i++; j++; }
    else if (j < m && (i === n || L[at(i, j + 1)] >= L[at(i + 1, j)])) { push('ins', ys[j]); j++; }
    else { push('del', xs[i]); i++; }
  }
  if (tail) push('same', x.slice(x.length - tail).join(''));
  return tidy(out);
}

/**
 * A single changed space between two changed words reads as noise
 * ("[old] [new]" twice); fold whitespace-only "same" pieces that sit
 * between changes into both sides.
 */
function tidy(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (let k = 0; k < pieces.length; k++) {
    const p = pieces[k];
    const prev = pieces[k - 1];
    const next = pieces[k + 1];
    if (p.op === 'same' && /^\s+$/.test(p.text) && p.text.length < 3 && prev && next && prev.op !== 'same' && next.op !== 'same') {
      out.push({ op: 'del', text: p.text }, { op: 'ins', text: p.text });
      continue;
    }
    out.push({ ...p });
  }
  // Re-merge neighbours and order each changed run as deletions then insertions.
  const merged: Piece[] = [];
  let run: Piece[] = [];
  const flush = () => {
    if (!run.length) return;
    const del = run.filter((r) => r.op === 'del').map((r) => r.text).join('');
    const ins = run.filter((r) => r.op === 'ins').map((r) => r.text).join('');
    if (del) merged.push({ op: 'del', text: del });
    if (ins) merged.push({ op: 'ins', text: ins });
    run = [];
  };
  for (const p of out) {
    if (p.op === 'same') { flush(); merged.push(p); } else run.push(p);
  }
  flush();
  return merged;
}

export interface DiffBlock {
  kind: 'file' | 'hunk' | 'context' | 'change';
  text?: string;
  /** For changes: the word-level pieces, or null to show the removed and added lines whole. */
  pieces?: Piece[] | null;
  removed?: string;
  added?: string;
}

/** Unified patch → display blocks: each run of removed lines and the added lines after it is one change. */
export function patchBlocks(patch: string): DiffBlock[] {
  const out: DiffBlock[] = [];
  const lines = patch.split('\n');
  let del: string[] = [];
  let ins: string[] = [];
  const flush = () => {
    if (!del.length && !ins.length) return;
    const removed = del.join('\n');
    const added = ins.join('\n');
    out.push({ kind: 'change', removed, added, pieces: wordDiff(removed, added) });
    del = [];
    ins = [];
  };
  for (const l of lines) {
    if (l.startsWith('diff --git')) {
      flush();
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
      out.push({ kind: 'file', text: m ? (m[1] === m[2] ? m[1] : `${m[1]} → ${m[2]}`) : l });
    } else if (/^(index |--- |\+\+\+ |new file mode|deleted file mode)/.test(l)) {
      continue;
    } else if (l.startsWith('@@')) {
      flush();
      out.push({ kind: 'hunk', text: l });
    } else if (l.startsWith('-')) {
      if (ins.length) flush();
      del.push(l.slice(1));
    } else if (l.startsWith('+')) {
      ins.push(l.slice(1));
    } else {
      flush();
      if (l || out.length) out.push({ kind: 'context', text: l.slice(1) });
    }
  }
  flush();
  while (out.length && out[out.length - 1].kind === 'context' && !out[out.length - 1].text) out.pop();
  return out;
}
