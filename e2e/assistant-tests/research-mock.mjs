// Stand-ins for the assistant's free research services, so the suite needs no
// network: OpenAlex (/openalex), arXiv (/arxiv), SearXNG (/searxng), doi.org
// BibTeX content negotiation (/doi, for Aldine's references_add) and one
// scholarly web page (/page).
import http from 'node:http';

const PORT = Number(process.env.RESEARCH_MOCK_PORT || 3263);
const BASE = `http://127.0.0.1:${PORT}`;
const DOI = '10.5555/swarm.2025.42';
const WORK = {
  id: 'https://openalex.org/W4242424242',
  doi: `https://doi.org/${DOI}`,
  display_name: 'Coordinating Swarms of Simple Robots',
  publication_year: 2025,
  authorships: [{ author: { display_name: 'Grace Hopper' } }, { author: { display_name: 'Alan Turing' } }, { author: { display_name: 'Ada Lovelace' } }],
  primary_location: { source: { display_name: 'Journal of Swarm Studies' }, landing_page_url: `https://doi.org/${DOI}` },
  cited_by_count: 1234,
  open_access: { is_oa: false, oa_url: null },
  best_oa_location: null,
  type: 'article',
  abstract_inverted_index: { We: [0], coordinate: [1], swarms: [2], 'robots.': [5], of: [3], simple: [4] },
};
const BIB = `@article{Hopper_2025, title={Coordinating Swarms of Simple Robots}, volume={7}, DOI={${DOI}}, journal={Journal of Swarm Studies}, author={Hopper, Grace and Turing, Alan and Lovelace, Ada}, year={2025}, pages={1--12} }`;
const PAGE = `<!doctype html><html><head><title>Swarm robotics overview</title>
<meta name="description" content="An overview page about swarm robotics.">
</head><body><nav>menu</nav><main><h1>Swarm robotics</h1><p>Swarm robotics coordinates many simple robots through local rules.</p></main></body></html>`;

const json = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

http.createServer((req, res) => {
  const url = new URL(req.url, BASE);
  const p = url.pathname;
  if (p === '/openalex/works') return json(res, { results: [WORK] });
  if (p.startsWith('/openalex/works/doi:')) return decodeURIComponent(p).toLowerCase().includes(DOI) ? json(res, WORK) : json(res, { error: 'not found' }, 404);
  if (p === '/arxiv/query') { res.writeHead(200, { 'content-type': 'application/atom+xml' }); return res.end('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>'); }
  if (p === '/searxng/search') return json(res, { results: [{ title: 'Swarm robotics overview', url: `${BASE}/page`, content: 'An overview page about swarm robotics.', engine: 'mock' }] });
  if (p === '/page') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
  if (decodeURIComponent(p).toLowerCase() === `/doi/${DOI}`) { res.writeHead(200, { 'content-type': 'application/x-bibtex' }); return res.end(BIB); }
  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1');
