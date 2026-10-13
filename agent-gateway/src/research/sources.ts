import { decodeEntities, FetchError, fetchJson, safeFetch, type SafeFetchOptions } from './net.ts';

/** One scholarly work, whatever index it came from. */
export interface Work {
  id: string;
  source: 'openalex' | 'arxiv';
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  type: string | null;
  doi: string | null;
  arxivId: string | null;
  citedBy: number | null;
  abstract: string | null;
  /** Open-access full text (PDF or HTML), when one is known. */
  oaUrl: string | null;
  url: string;
}

export interface WebResult { title: string; url: string; snippet: string; engine: string | null; published: string | null }

export interface ResearchConfig {
  enabled: boolean;
  /** Contact address for the OpenAlex polite pool (faster, more reliable); optional. */
  email: string | null;
  openalexBase: string;
  arxivBase: string;
  /** SearXNG instance with the JSON format enabled; null = no general web search. */
  searxngUrl: string | null;
  fetchEnabled: boolean;
  /** The reffix sidecar (check_bibliography); null = no such tool. */
  reffixUrl?: string | null;
  /** Tests only. */
  allowPrivate?: boolean;
}

const normDoi = (d: string | null | undefined) => (d ? d.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim().toLowerCase() : null);

/** OpenAlex ships abstracts as an inverted index (word → positions). */
export function invertedToText(idx: Record<string, number[]> | null | undefined): string | null {
  if (!idx) return null;
  const words: string[] = [];
  for (const [w, positions] of Object.entries(idx)) for (const p of positions) words[p] = w;
  const text = words.filter((w) => w !== undefined).join(' ').trim();
  return text || null;
}

const OA_SELECT = 'id,doi,display_name,publication_year,authorships,primary_location,cited_by_count,open_access,best_oa_location,type,abstract_inverted_index,ids';

function fromOpenAlex(w: any): Work {
  const arxivLoc = [w.primary_location, w.best_oa_location].find((l: any) => /arxiv\.org\/abs\//.test(l?.landing_page_url ?? ''));
  const arxivId = arxivLoc ? /arxiv\.org\/abs\/([^v?#]+)/.exec(arxivLoc.landing_page_url)?.[1] ?? null : null;
  return {
    id: String(w.id ?? '').replace('https://openalex.org/', ''),
    source: 'openalex',
    title: decodeEntities(String(w.display_name ?? 'Untitled')).replace(/<[^>]+>/g, ''),
    authors: (w.authorships ?? []).map((a: any) => a?.author?.display_name).filter(Boolean),
    year: w.publication_year ?? null,
    venue: w.primary_location?.source?.display_name ?? null,
    type: w.type ?? null,
    doi: normDoi(w.doi),
    arxivId,
    citedBy: typeof w.cited_by_count === 'number' ? w.cited_by_count : null,
    abstract: invertedToText(w.abstract_inverted_index),
    oaUrl: w.best_oa_location?.pdf_url ?? w.open_access?.oa_url ?? null,
    url: w.doi ?? w.id,
  };
}

export interface LiteratureQuery {
  query: string;
  fromYear?: number;
  toYear?: number;
  openAccessOnly?: boolean;
  sort?: 'relevance' | 'citations' | 'recent';
  limit?: number;
}

export async function searchOpenAlex(cfg: ResearchConfig, q: LiteratureQuery, signal?: AbortSignal): Promise<Work[]> {
  const params = new URLSearchParams({ search: q.query, 'per-page': String(Math.min(q.limit ?? 8, 25)), select: OA_SELECT });
  const filters: string[] = [];
  if (q.fromYear) filters.push(`from_publication_date:${q.fromYear}-01-01`);
  if (q.toYear) filters.push(`to_publication_date:${q.toYear}-12-31`);
  if (q.openAccessOnly) filters.push('is_oa:true');
  if (filters.length) params.set('filter', filters.join(','));
  if (q.sort === 'citations') params.set('sort', 'cited_by_count:desc');
  else if (q.sort === 'recent') params.set('sort', 'publication_date:desc');
  if (cfg.email) params.set('mailto', cfg.email);
  const r = await fetchJson<{ results?: any[] }>(`${cfg.openalexBase}/works?${params}`, { signal, allowPrivate: cfg.allowPrivate });
  return (r.results ?? []).map(fromOpenAlex);
}

export async function openAlexByDoi(cfg: ResearchConfig, doi: string, signal?: AbortSignal): Promise<Work | null> {
  const params = new URLSearchParams({ select: OA_SELECT, ...(cfg.email ? { mailto: cfg.email } : {}) });
  try {
    return fromOpenAlex(await fetchJson<any>(`${cfg.openalexBase}/works/doi:${encodeURIComponent(normDoi(doi)!)}?${params}`, { signal, allowPrivate: cfg.allowPrivate }));
  } catch (err) {
    if (err instanceof FetchError && /404/.test(err.message)) return null;
    throw err;
  }
}

// ---------- arXiv (Atom feed) ----------

// arXiv asks API clients for one request at a time, three seconds apart, and
// answers slowly; one queue per process keeps the gateway inside that.
const ARXIV_GAP_MS = 3000;
const ARXIV_TIMEOUT_MS = 30_000;
let arxivQueue: Promise<unknown> = Promise.resolve();
let arxivLast = 0;
function arxivGet(url: string, opts: SafeFetchOptions) {
  const next = arxivQueue.then(async () => {
    const wait = arxivLast + ARXIV_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      const r = await safeFetch(url, { timeoutMs: ARXIV_TIMEOUT_MS, accept: 'application/atom+xml', ...opts });
      if (r.status === 429 || r.status === 503) throw new FetchError('arXiv is rate-limiting requests right now');
      if (r.status >= 400) throw new FetchError(`arXiv answered ${r.status}`);
      return r.body.toString('utf8');
    } finally {
      arxivLast = Date.now();
    }
  });
  arxivQueue = next.catch(() => {});
  return next;
}

const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : null;
};

export function parseArxivFeed(xml: string): Work[] {
  const out: Work[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const absUrl = tag(e, 'id') ?? '';
    const arxivId = /arxiv\.org\/abs\/([^v]+?)(v\d+)?$/.exec(absUrl)?.[1] ?? null;
    if (!arxivId) continue;
    const pdf = /<link[^>]*title="pdf"[^>]*href="([^"]+)"|<link[^>]*href="([^"]+)"[^>]*title="pdf"/.exec(e);
    out.push({
      id: `arXiv:${arxivId}`,
      source: 'arxiv',
      title: tag(e, 'title') ?? 'Untitled',
      authors: [...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((a) => decodeEntities(a[1]).trim()),
      year: Number((tag(e, 'published') ?? '').slice(0, 4)) || null,
      venue: 'arXiv',
      type: 'preprint',
      doi: normDoi(tag(e, 'arxiv:doi')),
      arxivId,
      citedBy: null,
      abstract: tag(e, 'summary'),
      oaUrl: pdf ? (pdf[1] ?? pdf[2]) : `https://arxiv.org/pdf/${arxivId}`,
      url: `https://arxiv.org/abs/${arxivId}`,
    });
  }
  return out;
}

export async function searchArxiv(cfg: ResearchConfig, q: LiteratureQuery, signal?: AbortSignal): Promise<Work[]> {
  const terms = q.query.split(/\s+/).filter(Boolean).map((t) => `all:${t.replace(/[^\p{L}\p{N}-]/gu, '')}`).filter((t) => t.length > 4);
  const params = new URLSearchParams({ search_query: terms.join(' AND ') || `all:${q.query}`, max_results: String(Math.min(q.limit ?? 8, 25)), ...(q.sort === 'recent' ? { sortBy: 'submittedDate', sortOrder: 'descending' } : {}) });
  const xml = await arxivGet(`${cfg.arxivBase}/query?${params}`, { signal, allowPrivate: cfg.allowPrivate });
  return parseArxivFeed(xml).filter((w) => (!q.fromYear || (w.year ?? 0) >= q.fromYear) && (!q.toYear || (w.year ?? 9999) <= q.toYear));
}

export async function arxivById(cfg: ResearchConfig, id: string, signal?: AbortSignal): Promise<Work | null> {
  const xml = await arxivGet(`${cfg.arxivBase}/query?id_list=${encodeURIComponent(id.replace(/^arxiv:/i, ''))}`, { signal, allowPrivate: cfg.allowPrivate });
  return parseArxivFeed(xml)[0] ?? null;
}

// ---------- merged search ----------

const titleKey = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** OpenAlex first (published work, citations), arXiv for preprints; duplicates collapse onto the OpenAlex record. */
export async function searchLiterature(cfg: ResearchConfig, q: LiteratureQuery, sources: ('openalex' | 'arxiv')[], signal?: AbortSignal): Promise<{ works: Work[]; errors: string[] }> {
  const errors: string[] = [];
  const settled = await Promise.all(sources.map(async (s) => {
    try { return s === 'openalex' ? await searchOpenAlex(cfg, q, signal) : await searchArxiv(cfg, q, signal); } catch (err) { errors.push(`${s}: ${(err as Error).message}`); return []; }
  }));
  const out: Work[] = [];
  const seen = new Map<string, Work>();
  for (const w of settled.flat()) {
    const keys = [w.doi && `doi:${w.doi}`, w.arxivId && `arxiv:${w.arxivId}`, `t:${titleKey(w.title)}`].filter(Boolean) as string[];
    const dup = keys.map((k) => seen.get(k)).find(Boolean);
    if (dup) {
      dup.arxivId ??= w.arxivId;
      dup.oaUrl ??= w.oaUrl;
      dup.abstract ??= w.abstract;
      continue;
    }
    out.push(w);
    for (const k of keys) seen.set(k, w);
  }
  return { works: out.slice(0, Math.min(q.limit ?? 8, 25)), errors };
}

// ---------- SearXNG ----------

export async function webSearch(cfg: ResearchConfig, query: string, limit = 8, signal?: AbortSignal): Promise<WebResult[]> {
  if (!cfg.searxngUrl) throw new FetchError('General web search is not configured on this server (SEARXNG_URL).');
  // The instance is the operator's own service, typically on the internal network.
  const r = await fetchJson<{ results?: any[] }>(`${cfg.searxngUrl.replace(/\/+$/, '')}/search?${new URLSearchParams({ q: query, format: 'json', safesearch: '1' })}`, { signal, allowPrivate: true });
  return (r.results ?? []).slice(0, limit).map((x) => ({
    title: String(x.title ?? x.url ?? '').trim(),
    url: String(x.url ?? ''),
    snippet: String(x.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 400),
    engine: x.engine ?? (Array.isArray(x.engines) ? x.engines[0] : null) ?? null,
    published: x.publishedDate ?? null,
  })).filter((x) => /^https?:\/\//.test(x.url));
}
