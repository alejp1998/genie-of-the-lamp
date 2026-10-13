import { describe, expect, it } from 'vitest';
import { patchBlocks, wordDiff } from '../wordDiff';

const render = (a: string, b: string) => wordDiff(a, b)!.map((p) => (p.op === 'same' ? p.text : p.op === 'del' ? `[-${p.text}-]` : `{+${p.text}+}`)).join('');

describe('wordDiff', () => {
  it('marks only the changed words inside a long line', () => {
    const a = 'Three placements produced successful detections, with best mean localization errors of 1.21\\,m; the fourth remained unresolved.';
    const b = 'Victims were found at three of the four placements; the fourth remained unresolved.';
    const out = render(a, b);
    expect(out.endsWith('; the fourth remained unresolved.')).toBe(true);
    expect(out).toContain('[-');
    expect(out).toContain('{+');
  });

  it('keeps LaTeX commands whole', () => {
    expect(render('a \\emph{fast} system', 'a \\textbf{fast} system')).toBe('a [-\\emph-]{+\\textbf+}{fast} system');
  });

  it('a one-word change is one deletion and one insertion', () => {
    expect(render('operations require rapid coverage', 'operations need rapid coverage')).toBe('operations [-require-]{+need+} rapid coverage');
  });

  it('pure insertions and deletions', () => {
    expect(render('a b', 'a new b')).toBe('a {+new +}b');
    expect(render('a old b', 'a b')).toBe('a [-old -]b');
  });
});

describe('patchBlocks', () => {
  it('pairs removed and added lines into one change; context and file rows pass through', () => {
    const patch = 'diff --git a/main.tex b/main.tex\n--- a/main.tex\n+++ b/main.tex\n@@ -1,3 +1,3 @@\n \\begin{abstract}\n-Old sentence here.\n+New sentence here.\n \\end{abstract}\n';
    const blocks = patchBlocks(patch);
    expect(blocks.map((b) => b.kind)).toEqual(['file', 'hunk', 'context', 'change', 'context']);
    expect(blocks[3].pieces!.map((p) => p.op)).toEqual(['del', 'ins', 'same']);
  });
});
