/**
 * Which optional sidebar tabs (plugin panels) this browser shows. With the
 * assistant deployed, Cite and Zotero start hidden: the assistant covers
 * citing, and the tabs stay one setting away.
 */
const KEY = 'aldine.sidebarTabs';
const HIDDEN_WITH_ASSISTANT = new Set(['plugin:references', 'plugin:zotero']);

export type TabPrefs = Record<string, boolean>;

export function loadTabPrefs(): TabPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function saveTabPrefs(prefs: TabPrefs) {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* storage unavailable: the choice lasts this page */ }
}

export const tabShown = (prefs: TabPrefs, id: string, assistant: boolean) => prefs[id] ?? !(assistant && HIDDEN_WITH_ASSISTANT.has(id));
