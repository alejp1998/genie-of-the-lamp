import { wordDiff } from '../components/wordDiff';
import { latexToPlain } from '../components/pdfFind';

/** Window event the panel sends once an accepted change has typeset: {path, line, text, acceptedAt}. */
export const CHANGE_EVENT = 'genie:show-change';

/** Where an accepted change is: its file, first changed line (in the new text) and what to look for in the PDF. */
export interface ChangeTarget { path: string; line: number; text: string | null }

/**
 * The first change in a unified patch, preferring .tex files (a reference
 * proposal also edits the .bib, which prints nothing at that spot). `text`
 * is the inserted words as they print; when they print nothing (a \cite),
 * the words just before them.
 */
export function firstChange(patch: string): ChangeTarget | null {
  const found: ChangeTarget[] = [];
  let path: string | null = null;
  let newLine = 0;
  let del: string[] = [];
  let ins: string[] = [];
  let at = 0;
  let done = false;
  const flush = () => {
    if (path && !done && (del.length || ins.length)) {
      const pieces = wordDiff(del.join('\n'), ins.join('\n'));
      let text: string | null = null;
      if (pieces) {
        const i = pieces.findIndex((p) => p.op === 'ins');
        const inserted = i >= 0 ? latexToPlain(pieces.slice(i).filter((p, k, a) => p.op !== 'del' && a.slice(0, k + 1).every((q) => q.op !== 'same')).map((p) => p.text).join('')) : '';
        const before = latexToPlain(pieces.slice(0, Math.max(0, i >= 0 ? i : pieces.findIndex((p) => p.op === 'del'))).filter((p) => p.op === 'same').map((p) => p.text).join('')).split(' ').slice(-4).join(' ');
        text = inserted.length >= 2 ? inserted.slice(0, 200) : before || null;
      } else text = latexToPlain(ins[0] ?? '').slice(0, 200) || null;
      found.push({ path, line: at, text });
      done = true;
    }
    del = [];
    ins = [];
  };
  for (const l of patch.split('\n')) {
    const file = /^diff --git a\/.+? b\/(.+)$/.exec(l) ?? /^\+\+\+ b\/(.+)$/.exec(l);
    if (file) { flush(); path = file[1]; done = false; continue; }
    if (/^(index |--- |\+\+\+ |new file mode|deleted file mode)/.test(l)) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (hunk) { flush(); newLine = Number(hunk[1]); continue; }
    if (l.startsWith('-')) { if (!del.length && !ins.length) at = newLine; del.push(l.slice(1)); continue; }
    if (l.startsWith('+')) { if (!del.length && !ins.length) at = newLine; ins.push(l.slice(1)); newLine++; continue; }
    flush();
    newLine++;
  }
  flush();
  return found.find((c) => /\.tex$/i.test(c.path)) ?? null;
}
