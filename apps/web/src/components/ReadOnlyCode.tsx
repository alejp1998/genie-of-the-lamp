import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers, highlightSpecialChars, drawSelection } from '@codemirror/view';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { latex } from 'codemirror-lang-latex';
import { aldineHighlight, aldineTheme } from './CodePane';

/** Read-only text in the editor's look (line numbers, LaTeX highlighting, wrapping); selectable and copyable. */
export default function ReadOnlyCode({ text, language = 'latex' }: { text: string; language?: 'latex' | 'plain' }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(),
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
  }, [text, language]);
  return <div ref={host} className="code-pane" data-testid="readonly-code" />;
}
