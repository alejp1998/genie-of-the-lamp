import { StateField, type EditorState } from '@codemirror/state';
import { showTooltip, type Tooltip } from '@codemirror/view';

/** Opens (or focuses) the assistant with an editable prompt; never edits the document itself. */
export const PROMPT_EVENT = 'aldine:assistant-prompt';

export interface AssistantPrompt {
  text: string;
  /** Attach the editor selection to the message. */
  withSelection?: boolean;
  selection?: { text: string; fromLine: number; toLine: number };
}

/** Starts a review comment on the selection (the editor page opens its composer). */
export const COMMENT_EVENT = 'aldine:comment-selection';

export function askAssistant(p: AssistantPrompt) {
  window.dispatchEvent(new CustomEvent<AssistantPrompt>(PROMPT_EVENT, { detail: p }));
}

const ACTIONS: { label: string; prompt: string; testId: string }[] = [
  { label: 'Ask', prompt: '', testId: 'sel-ask' },
  { label: 'Explain', prompt: 'Explain the selected text in plain words.', testId: 'sel-explain' },
  { label: 'Improve', prompt: 'Improve the wording of the selected text without changing its meaning, claims, citations or labels. Propose it as a change.', testId: 'sel-improve' },
  { label: 'Fix LaTeX', prompt: 'Fix the LaTeX in the selected text (syntax, macros, environments, escaping) without changing the wording. Propose it as a change.', testId: 'sel-fix' },
  { label: 'Cite', prompt: 'Suggest citations from this project\'s bibliography for the selected text. Use only existing keys and propose the \\cite additions.', testId: 'sel-cite' },
];

const MIN_SELECTION = 3;

function selectionTooltip(state: EditorState): Tooltip | null {
  const sel = state.selection.main;
  if (sel.empty || sel.to - sel.from < MIN_SELECTION || typeof document === 'undefined') return null;
  const assistant = document.documentElement.dataset.assistant === '1';
  return {
    pos: sel.head,
    above: sel.head < sel.anchor || state.doc.lineAt(sel.head).number === 1 ? false : true,
    arrow: false,
    create: (view) => {
      const dom = document.createElement('div');
      dom.className = 'assistant-sel';
      dom.setAttribute('role', 'toolbar');
      dom.setAttribute('aria-label', 'Act on the selection');
      dom.dataset.testid = 'selection-actions';
      // Commenting is Aldine's own review feature: offered with or without an assistant.
      const comment = document.createElement('button');
      comment.type = 'button';
      comment.textContent = 'Comment';
      comment.className = 'assistant-sel__btn assistant-sel__btn--comment';
      comment.dataset.testid = 'sel-comment';
      comment.addEventListener('mousedown', (e) => e.preventDefault());
      comment.addEventListener('click', () => window.dispatchEvent(new Event(COMMENT_EVENT)));
      dom.appendChild(comment);
      if (!assistant) return { dom };
      const sep = document.createElement('span');
      sep.className = 'assistant-sel__sep';
      dom.appendChild(sep);
      for (const a of ACTIONS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = a.label;
        b.className = 'assistant-sel__btn';
        b.dataset.testid = a.testId;
        // mousedown would move the caret and drop the selection before the click lands
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', () => {
          const s = view.state.selection.main;
          const doc = view.state.doc;
          askAssistant({
            text: a.prompt,
            withSelection: true,
            selection: { text: view.state.sliceDoc(s.from, s.to).slice(0, 20_000), fromLine: doc.lineAt(s.from).number, toLine: doc.lineAt(s.to).number },
          });
        });
        dom.appendChild(b);
      }
      return { dom };
    },
  };
}

/** A small toolbar over the selection: Comment always, the assistant's actions where a gateway answers. */
export const assistantSelectionActions = StateField.define<Tooltip | null>({
  create: selectionTooltip,
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value;
    return selectionTooltip(tr.state);
  },
  provide: (f) => showTooltip.from(f),
});
