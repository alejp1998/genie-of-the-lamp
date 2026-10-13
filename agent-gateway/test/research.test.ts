import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { runLoop } from '../src/agent/loop.ts';
import { researchTools } from '../src/agent/researchTools.ts';
import { ASSISTANT_TOOLS, newRunState } from '../src/agent/tools.ts';
import { MockProvider } from '../src/providers/mock.ts';
import type { ChatMessage } from '../src/providers/types.ts';
import { FetchError, htmlToText, isPublicAddress, safeFetch } from '../src/research/net.ts';
import { invertedToText, parseArxivFeed, type ResearchConfig } from '../src/research/sources.ts';
import { FakeAldine, testConfig } from './helpers.ts';

/** A one-page PDF with real text. */
function tinyPdf(text: string): Buffer {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const stream = `BT /F1 12 Tf 20 120 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const WORK = {
  id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1186/s41018-018-0045-4', display_name: 'Search and rescue with autonomous flying robots', publication_year: 2018,
  authorships: [{ author: { display_name: 'Ross D. Arnold' } }, { author: { display_name: 'Hiroyuki Yamaguchi' } }],
  primary_location: { source: { display_name: 'Journal of International Humanitarian Action' }, landing_page_url: 'https://doi.org/10.1186/s41018-018-0045-4' },
  cited_by_count: 171, type: 'article', abstract_inverted_index: { Drones: [0], help: [1], rescue: [2], teams: [3] },
  best_oa_location: { pdf_url: '' }, open_access: { oa_url: '' },
};
const ARXIV = `<feed><entry><id>http://arxiv.org/abs/2509.16920v1</id><published>2025-09-21T04:59:21Z</published><title>SwarmChat: An LLM-Based Interaction System for Robotic Swarms</title><summary>We present SwarmChat &amp; friends.</summary><author><name>A. Author</name></author><link href="https://arxiv.org/pdf/2509.16920v1" rel="related" type="application/pdf" title="pdf"/></entry></feed>`;
const PAGE = `<html><head><title>Mission report</title><meta name="citation_title" content="Field trials of UAV swarms"><meta name="citation_doi" content="10.1234/abc"><meta name="citation_author" content="Rolland, E."></head><body><nav>menu menu</nav><article><h1>Field trials</h1><p>The swarm found 3 of 4 victims &amp; returned.</p><script>evil()</script>${'<p>More text about the trials.</p>'.repeat(20)}</article><footer>footer</footer></body></html>`;

let server: http.Server;
let base: string;
const hits: string[] = [];
before(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url!);
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/oa/works') { WORK.best_oa_location.pdf_url = `${base}/paper.pdf`; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ results: [WORK] })); }
    if (u.pathname.startsWith('/oa/works/doi:')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(WORK)); }
    if (u.pathname === '/arxiv/query') { res.setHeader('content-type', 'application/atom+xml'); return res.end(ARXIV); }
    if (u.pathname === '/searx/search') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ results: [{ title: 'SearXNG docs', url: 'https://docs.searxng.org/', content: 'A privacy-respecting metasearch engine', engine: 'duckduckgo' }, { title: 'bad', url: 'javascript:alert(1)' }] })); }
    if (u.pathname === '/page') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(PAGE); }
    if (u.pathname === '/paper.pdf') { res.setHeader('content-type', 'application/pdf'); return res.end(tinyPdf('Drones found the victims within ten metres.')); }
    if (u.pathname === '/redirect-private') { res.statusCode = 302; res.setHeader('location', 'http://127.0.0.1:1/secret'); return res.end(); }
    res.statusCode = 404; res.end('nf');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

const cfg = (): ResearchConfig => ({ enabled: true, email: 'test@example.org', openalexBase: `${base}/oa`, arxivBase: `${base}/arxiv`, searxngUrl: `${base}/searx`, fetchEnabled: true, allowPrivate: true });

test('public-address guard', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.20.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '10.211.108.8', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '151.101.1.69', '2a00:1450:4001::200e']) assert.equal(isPublicAddress(ip), true, ip);
});

test('safeFetch refuses private targets and private redirects, and non-http schemes', async () => {
  await assert.rejects(safeFetch(`${base}/page`), FetchError);
  await assert.rejects(safeFetch('http://localhost:9/x'), /non-public|not a public/);
  await assert.rejects(safeFetch('file:///etc/passwd'), /Only http and https/);
  // Even when the first hop is allowed (test mode), a redirect is re-checked hop by hop in production mode.
  await assert.rejects(safeFetch(`${base}/redirect-private`), FetchError);
});

test('HTML → readable text with citation metadata; scripts and chrome dropped', () => {
  const p = htmlToText(PAGE);
  assert.equal(p.title, 'Mission report');
  assert.deepEqual([p.citation?.title, p.citation?.doi, p.citation?.authors], ['Field trials of UAV swarms', '10.1234/abc', ['Rolland, E.']]);
  assert.match(p.text, /The swarm found 3 of 4 victims & returned\./);
  assert.doesNotMatch(p.text, /evil|menu|footer/);
});

test('OpenAlex abstracts and arXiv feeds parse', () => {
  assert.equal(invertedToText({ world: [1], hello: [0] }), 'hello world');
  const [w] = parseArxivFeed(ARXIV);
  assert.deepEqual([w.arxivId, w.year, w.authors[0], w.abstract], ['2509.16920', 2025, 'A. Author', 'We present SwarmChat & friends.']);
});

test('research tools through the loop: search, read full text, web search, fetch; sources for the panel', async () => {
  const config = testConfig();
  const aldine = new FakeAldine();
  const events: { type: string; data: any }[] = [];
  const persisted: ChatMessage[] = [];
  let turn = 0;
  const script = () => (++turn === 1 ? {
    toolCalls: [
      { name: 'search_literature', input: { query: 'drone search and rescue', from_year: 2015 } },
      { name: 'get_paper', input: { id: '10.1186/s41018-018-0045-4', full_text: true } },
      { name: 'web_search', input: { query: 'searxng' } },
      { name: 'fetch_url', input: { url: `${base}/page` } },
    ],
  } : { text: 'done' });
  const controller = new AbortController();
  const r = await runLoop({
    provider: new MockProvider('mock', script, 0), model: 'm', system: 's', tools: [...ASSISTANT_TOOLS, ...researchTools(cfg())],
    toolCtx: { aldine, token: 't', projectId: 'p1', branch: 'main', signal: controller.signal, limits: config.limits, state: newRunState(), research: cfg() },
    limits: config.limits, history: [{ role: 'user', blocks: [{ type: 'text', text: 'q' }] }], persist: (m) => persisted.push(m), emit: (type, data) => events.push({ type, data }), audit: () => {}, signal: controller.signal,
  });
  assert.equal(r.status, 'done');
  const results = persisted[1].blocks.map((b: any) => ({ err: b.isError, body: b.isError ? b.content : JSON.parse(b.content) }));
  assert.ok(results.every((x) => !x.err), JSON.stringify(results.filter((x) => x.err)));
  const [lit, paper, web, page] = results.map((x) => x.body);
  assert.equal(lit.works[0].id, '10.1186/s41018-018-0045-4');
  assert.equal(lit.works[0].abstract, 'Drones help rescue teams');
  assert.ok(lit.works.some((w: any) => w.id === 'arXiv:2509.16920'), 'arXiv results merged in');
  assert.match(paper.full_text.text, /Drones found the victims within ten metres\./);
  assert.match(paper.full_text.note, /Untrusted/);
  assert.deepEqual(web.results.map((x: any) => x.url), ['https://docs.searxng.org/'], 'non-http results dropped');
  assert.equal(page.citation.doi, '10.1234/abc');
  const end = (name: string) => events.find((e) => e.type === 'tool_end' && e.data.name === name)!.data;
  assert.equal(end('search_literature').sources[0].doi, '10.1186/s41018-018-0045-4');
  assert.equal(end('search_literature').sources[0].citedBy, 171);
  assert.equal(end('web_search').sources[0].kind, 'web');
  assert.equal(end('fetch_url').sources[0].kind, 'paper', 'a page with a citation DOI is a paper');
  assert.ok(hits.some((h) => h.includes('mailto=test%40example.org')), 'polite-pool email sent to OpenAlex');
});

test('research tools are absent when turned off; web search only with SearXNG', () => {
  assert.deepEqual(researchTools({ ...cfg(), enabled: false }), []);
  assert.deepEqual(researchTools({ ...cfg(), searxngUrl: null }).map((t) => t.name), ['search_literature', 'get_paper', 'fetch_url']);
});
