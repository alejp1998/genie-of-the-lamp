import type { EditorView } from '@codemirror/view';

/**
 * What was last copied or cut in the editor, and where from, so a paste
 * into the assistant's box can arrive as a `file:lines` reference chip
 * instead of loose text. Same page only: the clipboard itself carries plain
 * text, which CodeMirror's own copy handler rewrites.
 */
export interface EditorCopy { text: string; file: string; fromLine: number; toLine: number }

let last: EditorCopy | null = null;

const norm = (s: string) => s.replace(/\r\n?/g, '\n').replace(/\n+$/, '');

export function rememberEditorCopy(view: EditorView, file: string) {
  const { state } = view;
  const sel = state.selection.main;
  // An empty selection copies its whole line (CodeMirror's line-wise copy).
  const from = sel.empty ? state.doc.lineAt(sel.head).from : sel.from;
  const to = sel.empty ? state.doc.lineAt(sel.head).to : sel.to;
  const text = state.sliceDoc(from, to);
  if (!text.trim()) { last = null; return; }
  // A selection that ends at the start of a line (a triple-click takes the newline) ends on the line before.
  const end = to > from && state.doc.lineAt(to).from === to ? to - 1 : to;
  last = { text, file, fromLine: state.doc.lineAt(from).number, toLine: state.doc.lineAt(end).number };
}

/** The editor origin of pasted text, when it is what the editor last copied; short inline bits stay plain text. */
export function editorOrigin(pasted: string): EditorCopy | null {
  if (!last || norm(pasted) !== norm(last.text)) return null;
  const t = norm(pasted);
  return t.includes('\n') || t.length >= 30 ? last : null;
}

export const copyLabel = (c: EditorCopy) => `${c.file}:${c.fromLine}${c.toLine !== c.fromLine ? `–${c.toLine}` : ''}`;
