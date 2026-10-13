import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { Decoration, EditorView, lineNumbers, highlightSpecialChars, drawSelection } from '@codemirror/view';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { latex } from 'codemirror-lang-latex';
import { aldineHighlight, aldineTheme } from './CodePane';

/** Read-only text in the editor's look (line numbers, LaTeX highlighting, wrapping); selectable and copyable. */
export default function ReadOnlyCode({ text, language = 'latex', firstLine = 1, mark, testId = 'readonly-code' }: {
  text: string;
  language?: 'latex' | 'plain';
  /** Number shown on the first line, for an excerpt of a file. */
  firstLine?: number;
  /** A range to highlight (offsets into `text`), e.g. what a comment is about. */
  mark?: { from: number; to: number };
  testId?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers({ formatNumber: (n) => String(n + firstLine - 1) }),
          ...(mark && mark.to > mark.from ? [EditorView.decorations.of(Decoration.set([Decoration.mark({ class: 'cm-commentTarget' }).range(mark.from, Math.min(mark.to, text.length))]))] : []),
          highlightSpecialChars(),
          drawSelection(),
          ...(language === 'latex' ? [latex()] : []),
          syntaxHighlighting(aldineHighlight),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          aldineTheme,
        ],
      }),
    });
    return () => view.destroy();
  }, [text, language, firstLine, mark?.from, mark?.to]);
  return <div ref={host} className="code-pane" data-testid={testId} />;
}
