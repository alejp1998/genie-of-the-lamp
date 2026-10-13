/**
 * Messages this browser sent to the assistant, newest last, for Up/Down
 * recall in the chat box (like a shell). Local to the browser; never sent
 * anywhere. Storage can be unavailable (private windows): then it lasts the page.
 */
const KEY = 'genie.chatHistory';
const MAX = 100;
let memory: string[] | null = null;

export function loadHistory(): string[] {
  if (memory) return memory;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    memory = Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(-MAX) : [];
  } catch {
    memory = [];
  }
  return memory;
}

export function pushHistory(text: string) {
  const t = text.trim();
  if (!t) return;
  const list = loadHistory().filter((x) => x !== t);
  list.push(t);
  memory = list.slice(-MAX);
  try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* storage unavailable */ }
}
