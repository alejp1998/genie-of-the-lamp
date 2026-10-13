import { structuredPatch } from 'diff';

/**
 * Quote-anchored edits, with the same rules as Aldine's MCP edit tools
 * (apps/server/src/mcp/tools.ts resolveEdits): a quote of at least 8
 * characters, matched exactly, unique unless `occurrence` picks one, and no
 * two edits overlapping. Validating here first means a proposal the user
 * sees will also apply, unless the text changes in between.
 */

export const MIN_QUOTE_LEN = 8;
const MAX_OCCURRENCE_SCAN = 200;

export interface EditSpec {
  quote: string;
  replacement: string;
  occurrence?: number;
}

export type Resolution =
  | { ok: true; ranges: { from: number; to: number }[] }
  | { ok: false; editIndex: number; reason: string; candidates: { line: number; text: string; occurrence?: number }[] };

function lineAt(content: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < content.length; i++) if (content.charCodeAt(i) === 10) n++;
  return n;
}

function lineText(content: string, offset: number): string {
  const start = content.lastIndexOf('\n', offset - 1) + 1;
  const end = content.indexOf('\n', offset);
  return content.slice(start, end < 0 ? undefined : end).slice(0, 200);
}

/** Lines that share the most words with the quote: what the model should re-anchor on. */
function nearest(content: string, quote: string) {
  const words = new Set(quote.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  if (!words.size) return [];
  const scored = content.split('\n').map((text, i) => ({ line: i + 1, text: text.slice(0, 200), score: text.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length }));
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).map(({ line, text }) => ({ line, text }));
}

export function resolveEdits(content: string, edits: EditSpec[]): Resolution {
  const ranges: { from: number; to: number }[] = [];
  for (let i = 0; i < edits.length; i++) {
    const { quote, occurrence } = edits[i];
    if (quote.length < MIN_QUOTE_LEN) {
      return { ok: false, editIndex: i, reason: `the quote must be at least ${MIN_QUOTE_LEN} characters; quote more of the surrounding text`, candidates: [] };
    }
    const hits: number[] = [];
    for (let at = content.indexOf(quote); at >= 0 && hits.length < MAX_OCCURRENCE_SCAN; at = content.indexOf(quote, at + 1)) hits.push(at);
    if (!hits.length) return { ok: false, editIndex: i, reason: 'the quote is not in the file; re-read it and quote the current text exactly', candidates: nearest(content, quote) };
    let from: number;
    if (occurrence !== undefined) {
      if (occurrence < 1 || occurrence > hits.length) {
        return { ok: false, editIndex: i, reason: `occurrence ${occurrence} is out of range; the quote appears ${hits.length} time(s)`, candidates: hits.slice(0, 10).map((h, k) => ({ line: lineAt(content, h), text: lineText(content, h), occurrence: k + 1 })) };
      }
      from = hits[occurrence - 1];
    } else if (hits.length > 1) {
      return { ok: false, editIndex: i, reason: `the quote appears ${hits.length} times; quote more context or pass the occurrence you mean`, candidates: hits.slice(0, 10).map((h, k) => ({ line: lineAt(content, h), text: lineText(content, h), occurrence: k + 1 })) };
    } else {
      from = hits[0];
    }
    ranges.push({ from, to: from + quote.length });
  }
  const order = ranges.map((r, i) => ({ ...r, i })).sort((a, b) => a.from - b.from);
  for (let k = 1; k < order.length; k++) {
    if (order[k].from < order[k - 1].to) {
      return { ok: false, editIndex: order[k].i, reason: `edit ${order[k].i + 1} overlaps edit ${order[k - 1].i + 1}; merge them into one edit`, candidates: [] };
    }
  }
  return { ok: true, ranges };
}

export function spliceEdits(content: string, edits: EditSpec[], ranges: { from: number; to: number }[]): string {
  const order = ranges.map((r, i) => ({ ...r, replacement: edits[i].replacement })).sort((a, b) => b.from - a.from);
  let out = content;
  for (const e of order) out = out.slice(0, e.from) + e.replacement + out.slice(e.to);
  return out;
}

export function describeFailure(path: string, r: Extract<Resolution, { ok: false }>): string {
  const cands = r.candidates.length
    ? ` Candidates: ${r.candidates.map((c) => `line ${c.line}${c.occurrence ? ` (occurrence ${c.occurrence})` : ''}: ${JSON.stringify(c.text)}`).join('; ')}`
    : '';
  return `Edit ${r.editIndex + 1} in ${path}: ${r.reason}.${cands}`;
}

export interface FileDiff {
  patch: string;
  added: number;
  removed: number;
}

/** One file's unified diff with a `diff --git` header (what Aldine's DiffView renders). */
export function fileDiff(path: string, before: string | null, after: string): FileDiff {
  const p = structuredPatch(before === null ? '/dev/null' : `a/${path}`, `b/${path}`, before ?? '', after, '', '', { context: 3 });
  let added = 0;
  let removed = 0;
  const lines = [`diff --git a/${path} b/${path}`];
  if (before === null) lines.push('new file mode 100644');
  lines.push(`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ b/${path}`);
  for (const h of p.hunks) {
    lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const l of h.lines) {
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
      lines.push(l);
    }
  }
  return { patch: lines.join('\n') + '\n', added, removed };
}
