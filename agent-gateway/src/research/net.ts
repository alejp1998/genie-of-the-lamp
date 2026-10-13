import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

/**
 * Outbound HTTP for research tools. The model chooses the URL, so this is
 * the server-side-request-forgery boundary: only http(s), only public
 * addresses (checked on the address actually connected to, which also
 * defeats DNS rebinding), redirects re-checked hop by hop, bounded time and
 * size.
 */

export class FetchError extends Error {}

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const UA = 'GenieResearch/0.1 (+https://github.com/alejp1998/genie-of-the-lamp; research assistant fetching pages a user asked about)';

/** Loopback, private, link-local, CGNAT, multicast, documentation and other non-public ranges. */
export function isPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && [0, 2].includes(Number(ip.split('.')[2]))))) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && Number(ip.split('.')[2]) === 100) return false;
    if (a === 203 && b === 0 && Number(ip.split('.')[2]) === 113) return false;
    if (a >= 224) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::' || low === '::1') return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
    if (mapped) return isPublicAddress(mapped[1]);
    if (/^(fc|fd)/.test(low) || /^fe[89ab]/.test(low) || /^ff/.test(low) || low.startsWith('2001:db8')) return false;
    return true;
  }
  return false;
}

/** A dns.lookup that refuses non-public answers, used at connect time. */
function guardedLookup(hostname: string, options: dns.LookupOptions, cb: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, '', 0);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (bad || !list.length) return cb(Object.assign(new Error(`${hostname} resolves to a non-public address`), { code: 'EBLOCKED' }), '', 0);
    if (options.all) cb(null, list);
    else cb(null, list[0].address, list[0].family);
  });
}

export interface FetchedDoc {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: Buffer;
  truncated: boolean;
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  accept?: string;
  /** Tests only: allow loopback targets (a local mock server). */
  allowPrivate?: boolean;
}

function once(url: URL, opts: SafeFetchOptions): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    if (!opts.allowPrivate && net.isIP(url.hostname) && !isPublicAddress(url.hostname)) {
      reject(new FetchError(`${url.hostname} is not a public address`));
      return;
    }
    const req = mod.request(url, {
      method: 'GET',
      headers: { 'user-agent': UA, accept: opts.accept ?? 'text/html,application/xhtml+xml,application/pdf,text/plain,application/json;q=0.9,*/*;q=0.5', 'accept-encoding': 'gzip, deflate, br' },
      ...(opts.allowPrivate ? {} : { lookup: guardedLookup as unknown as net.LookupFunction }),
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: opts.signal,
    }, (res) => {
      const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;
      const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
      const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res;
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      stream.on('data', (c: Buffer) => {
        if (truncated) return;
        size += c.length;
        if (size > max) { truncated = true; chunks.push(c.subarray(0, c.length - (size - max))); res.destroy(); stream.emit('end'); return; }
        chunks.push(c);
      });
      stream.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated }));
      stream.on('error', (e) => (truncated ? resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated }) : reject(e)));
    });
    req.on('timeout', () => req.destroy(new FetchError(`${url.host} did not answer within ${Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} s`)));
    req.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'EBLOCKED' ? new FetchError(e.message) : e instanceof FetchError ? e : new FetchError(`Could not fetch ${url.host}: ${e.message}`)));
    req.end();
  });
}

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<FetchedDoc> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new FetchError(`Not a URL: ${rawUrl}`); }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new FetchError(`Only http and https links can be read (got ${url.protocol})`);
    if (url.username || url.password) throw new FetchError('Links with credentials are not fetched');
    const r = await once(url, opts);
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      url = new URL(String(r.headers.location), url);
      continue;
    }
    return { url: rawUrl, finalUrl: url.toString(), status: r.status, contentType: String(r.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(), body: r.body, truncated: r.truncated };
  }
  throw new FetchError(`Too many redirects from ${rawUrl}`);
}

export async function fetchJson<T>(url: string, opts: SafeFetchOptions = {}): Promise<T> {
  const r = await safeFetch(url, { ...opts, accept: 'application/json' });
  if (r.status >= 400) throw new FetchError(`${new URL(url).host} answered ${r.status}`);
  try { return JSON.parse(r.body.toString('utf8')) as T; } catch { throw new FetchError(`${new URL(url).host} did not return JSON`); }
}

// ---------- text extraction ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', deg: '°', times: '×', minus: '−' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export interface PageText {
  title: string | null;
  description: string | null;
  /** Scholarly landing pages carry citation_* meta tags (Google Scholar convention). */
  citation: { title?: string; doi?: string; authors?: string[]; date?: string; journal?: string; pdfUrl?: string } | null;
  text: string;
}

function meta(html: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<meta\\s+[^>]*(?:name|property)=["']${name}["'][^>]*>`, 'gi');
  for (const m of html.matchAll(re)) {
    const c = /content=["']([^"']*)["']/i.exec(m[0]);
    if (c) out.push(decodeEntities(c[1]).trim());
  }
  return out;
}

/** Readable text from HTML without a DOM: drop chrome and scripts, prefer <article>/<main>, keep block structure. */
export function htmlToText(html: string): PageText {
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim()) || null;
  const description = meta(html, 'description')[0] ?? meta(html, 'og:description')[0] ?? null;
  const cTitle = meta(html, 'citation_title')[0];
  const citation = cTitle || meta(html, 'citation_doi')[0]
    ? {
      title: cTitle,
      doi: meta(html, 'citation_doi')[0],
      authors: meta(html, 'citation_author'),
      date: meta(html, 'citation_publication_date')[0] ?? meta(html, 'citation_date')[0],
      journal: meta(html, 'citation_journal_title')[0] ?? meta(html, 'citation_conference_title')[0],
      pdfUrl: meta(html, 'citation_pdf_url')[0],
    }
    : null;
  let body = html.replace(/<!--[\s\S]*?-->/g, '');
  body = body.replace(/<(script|style|noscript|svg|template|iframe|canvas)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = /<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body);
  if (main && main[2].length > 500) body = main[2];
  body = body.replace(/<(nav|header|footer|aside|form|button|select)\b[\s\S]*?<\/\1>/gi, ' ');
  body = body
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|section|article|li|ul|ol|tr|table|h[1-6]|blockquote|pre|figure|figcaption|dd|dt)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body)
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return { title, description, citation, text };
}

let pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs') | null = null;
export async function pdfToText(data: Buffer, maxChars = 200_000): Promise<{ text: string; pages: number }> {
  pdfjs ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  try {
    const parts: string[] = [];
    let total = 0;
    for (let i = 1; i <= doc.numPages && total < maxChars; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      const t = tc.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : ' ') : '')).join('').replace(/[ \t]+/g, ' ').trim();
      parts.push(`[page ${i}]\n${t}`);
      total += t.length;
    }
    return { text: parts.join('\n\n').slice(0, maxChars), pages: doc.numPages };
  } finally {
    void doc.destroy();
  }
}
