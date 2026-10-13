import { z } from 'zod';
import type { ResearchConfig } from '../research/sources.ts';
import { type AgentTool, readFresh } from './tools.ts';

/**
 * check_bibliography: the project's .bib run through reffix (DBLP), served by
 * the reffix sidecar (deploy/agent/reffix). Read-only: it reports what reffix
 * would change, entry by entry; the model proposes the fixes it agrees with.
 */

const MAX_ENTRIES = 40;
const ENTRY_CHARS = 3000;
const TIMEOUT_MS = 240_000;

export interface BibEntry { type: string; key: string; text: string }

/** Entries in file order, each with its exact text (for quoting in an edit). @string/@comment/@preamble are skipped. */
export function splitBib(bib: string): BibEntry[] {
  const starts = [...bib.matchAll(/^[ \t]*@([a-zA-Z]+)\s*\{\s*([^,\s]+)\s*,/gm)];
  const out: BibEntry[] = [];
  for (let i = 0; i < starts.length; i++) {
    const m = starts[i];
    if (['string', 'comment', 'preamble'].includes(m[1].toLowerCase())) continue;
    const text = bib.slice(m.index!, starts[i + 1]?.index ?? bib.length).trim();
    out.push({ type: m[1].toLowerCase(), key: m[2], text });
  }
  return out;
}

/** Field name → value with outer braces or quotes and runs of whitespace removed. */
export function bibFields(entry: string): Map<string, string> {
  const fields = new Map<string, string>();
  const body = entry.slice(entry.indexOf(',') + 1);
  const re = /([A-Za-z][\w-]*)\s*=\s*(\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}|"[^"]*"|[^,\n}]+)/g;
  for (const m of body.matchAll(re)) {
    let v = m[2].trim();
    if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
    fields.set(m[1].toLowerCase(), v.replace(/\s+/g, ' ').trim());
  }
  return fields;
}

type FieldChange = { field: string; from: string | null; to: string | null };

export function entryChanges(before: BibEntry, after: BibEntry): FieldChange[] {
  const a = bibFields(before.text);
  const b = bibFields(after.text);
  const out: FieldChange[] = [];
  if (before.type !== after.type) out.push({ field: '(entry type)', from: before.type, to: after.type });
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(name) ?? null;
    const y = b.get(name) ?? null;
    if (x !== y) out.push({ field: name, from: x, to: y });
  }
  return out;
}

const clip = (s: string) => (s.length > ENTRY_CHARS ? `${s.slice(0, ENTRY_CHARS)}…` : s);

export function checkBibliographyTool(cfg: ResearchConfig): AgentTool {
  return {
    name: 'check_bibliography',
    description: 'Check .bib entries with reffix against DBLP: it completes missing fields (venue, pages, DOI, URL), protects capitalisation in titles, and with replace_arxiv prefers the published version of an arXiv preprint. Citation keys never change. Returns, for each entry reffix would change, the field changes, the entry as it is now (original) and as reffix writes it (fixed); nothing is written. To apply fixes, propose them with propose_patch on that .bib: quote the original entry (or just the lines that change) and replace with the fixed text. DBLP covers computer science; other entries come back unchanged. Checks up to 40 entries per call; pass keys to choose which (e.g. those cited in a section).',
    schema: z.object({
      bib_file: z.string().max(500).optional().describe('Leave out for the .bib the main document loads, unless the user names one'),
      keys: z.array(z.string().min(1).max(200)).min(1).max(MAX_ENTRIES).optional().describe('Only these entries; default: the first 40'),
      replace_arxiv: z.boolean().optional().describe('Prefer published versions over arXiv preprints (default true)'),
    }).strict(),
    activity: (i) => `Checking ${i.keys?.length ? `${i.keys.length} ${i.keys.length === 1 ? 'entry' : 'entries'}` : 'the bibliography'} with reffix (DBLP)…`,
    summarize: (r) => `Checked ${r.checked} ${r.checked === 1 ? 'entry' : 'entries'} in ${r.bib_file}: ${r.changed.length} with fixes${r.problems?.length ? `, ${r.problems.length} lookup problem${r.problems.length === 1 ? '' : 's'}` : ''}`,
    timeoutMs: TIMEOUT_MS + 15_000,
    async run(input, ctx) {
      if (!cfg.reffixUrl) throw new Error('reffix is not set up on this server (REFFIX_URL).');
      let bibFile = input.bib_file;
      if (!bibFile) {
        const cites = await ctx.aldine.callTool(ctx.token, 'list_citations', { project: ctx.projectId, branch: ctx.branch }, { signal: ctx.signal });
        bibFile = cites.defaultBibFile ?? cites.citations?.[0]?.file;
        if (!bibFile) throw new Error('The project has no .bib file to check.');
      }
      const file = await readFresh(ctx, bibFile!);
      const entries = splitBib(file.content);
      if (!entries.length) throw new Error(`${bibFile} has no BibTeX entries.`);
      const wanted = input.keys ? entries.filter((e) => input.keys!.includes(e.key)) : entries.slice(0, MAX_ENTRIES);
      const missing = input.keys?.filter((k: string) => !entries.some((e) => e.key === k)) ?? [];
      if (!wanted.length) throw new Error(`None of those keys are in ${bibFile}.`);
      const res = await fetch(`${cfg.reffixUrl.replace(/\/+$/, '')}/fix`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bib: wanted.map((e) => e.text).join('\n\n') + '\n', replace_arxiv: input.replace_arxiv ?? true }),
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)].filter(Boolean) as AbortSignal[]),
      });
      const body = await res.json().catch(() => ({})) as { fixed?: string; log?: string[]; error?: string };
      if (!res.ok || typeof body.fixed !== 'string') throw new Error(`reffix failed: ${body.error ?? `HTTP ${res.status}`}`);
      const fixed = new Map(splitBib(body.fixed).map((e) => [e.key, e]));
      const changed = [];
      const unchanged: string[] = [];
      for (const e of wanted) {
        const f = fixed.get(e.key);
        const changes = f ? entryChanges(e, f) : [];
        if (!f || !changes.length) { unchanged.push(e.key); continue; }
        changed.push({ key: e.key, changes, original: clip(e.text), fixed: clip(f.text) });
      }
      const problems = [...new Set((body.log ?? []).filter((l) => /^\[(ERROR|WARNING)\]/.test(l)).map((l) => l.replace(/^\[\w+\]\s*/, '')))].slice(0, 10);
      const remaining = input.keys ? [] : entries.slice(MAX_ENTRIES).map((e) => e.key);
      return {
        bib_file: bibFile,
        checked: wanted.length,
        changed,
        unchanged,
        ...(missing.length ? { keys_not_in_file: missing } : {}),
        ...(problems.length ? { problems, note_on_problems: 'DBLP lookup problems (e.g. rate limiting) leave entries unchanged; they were not verified.' } : {}),
        ...(remaining.length ? { remaining_keys: remaining.slice(0, 200), note: `Only the first ${MAX_ENTRIES} entries were checked; call again with keys for the rest.` } : {}),
      };
    },
  };
}
