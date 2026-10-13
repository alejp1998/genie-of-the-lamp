import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bibFields, checkBibliographyTool, entryChanges, splitBib } from '../src/agent/bibCheck.ts';
import { FakeAldine } from './helpers.ts';

const BIB = `@string{ieee = "IEEE"}

@article{vaswani2017,
  title  = {Attention is all you need},
  author = {Vaswani, Ashish and Shazeer, Noam},
  year   = {2017},
  journal = {arXiv preprint arXiv:1706.03762},
}

@misc{mydata, title = {Our internal dataset}, year = 2024}
`;

test('splitBib keeps exact entry text and skips @string', () => {
  const e = splitBib(BIB);
  assert.deepEqual(e.map((x) => x.key), ['vaswani2017', 'mydata']);
  assert.ok(BIB.includes(e[0].text) && e[0].text.endsWith('}'));
  assert.equal(bibFields(e[1].text).get('year'), '2024');
});

test('check_bibliography reports field changes from reffix and keeps unchanged entries out', async () => {
  let sent: any = null;
  const sidecar = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      sent = JSON.parse(b);
      const fixed = `@inproceedings{vaswani2017,
  author    = {Vaswani, Ashish and Shazeer, Noam},
  booktitle = {Advances in Neural Information Processing Systems 30 ({NeurIPS})},
  pages     = {5998--6008},
  title     = {Attention is All you Need},
  year      = {2017}
}

@misc{mydata,
  title     = {Our internal dataset},
  year      = {2024}
}
`;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ fixed, log: ['[UPDATE]   (Vaswani, 2017) Attention', '[ERROR]    DBLP API returned status code 429', '[KEEP]     (mydata)'] }));
    });
  });
  await new Promise<void>((r) => sidecar.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(sidecar.address() as any).port}`;
  try {
    const aldine = new FakeAldine();
    aldine.files['refs.bib'] = BIB;
    const tool = checkBibliographyTool({ enabled: true, email: null, openalexBase: '', arxivBase: '', searxngUrl: null, fetchEnabled: false, reffixUrl: url });
    const ctx: any = { aldine, token: 't', projectId: 'p1', branch: 'main', signal: new AbortController().signal, limits: { toolTimeoutMs: 1000, maxToolResultChars: 40000 } };
    const r: any = await tool.run({ bib_file: 'refs.bib' }, ctx, { id: 'c1' });
    assert.equal(sent.replace_arxiv, true);
    assert.ok(!sent.bib.includes('@string'), 'only entries are sent');
    assert.equal(r.checked, 2);
    assert.deepEqual(r.unchanged, ['mydata'], 'reformatting alone is not a change');
    assert.equal(r.changed.length, 1);
    const c = r.changed[0];
    assert.equal(c.key, 'vaswani2017');
    assert.ok(BIB.includes(c.original), 'the original is quotable as is');
    const fields = Object.fromEntries(c.changes.map((x: any) => [x.field, x.to]));
    assert.equal(fields['(entry type)'], 'inproceedings');
    assert.equal(fields.pages, '5998--6008');
    assert.equal(fields.journal, null);
    assert.match(r.problems[0], /429/);
    assert.match(tool.summarize(r), /Checked 2 entries in refs\.bib: 1 with fixes, 1 lookup problem/);
  } finally {
    sidecar.close();
  }
});

test('entryChanges ignores layout', () => {
  const [a] = splitBib('@misc{k,\n  title = {A  B},\n}');
  const [b] = splitBib('@misc{k, title={A B}}');
  assert.deepEqual(entryChanges(a, b), []);
});
