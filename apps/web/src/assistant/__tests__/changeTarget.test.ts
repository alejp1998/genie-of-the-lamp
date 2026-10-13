import { describe, expect, it } from 'vitest';
import { firstChange } from '../changeTarget';
import { latexToPlain } from '../../components/pdfFind';

const PATCH = `diff --git a/refs.bib b/refs.bib
--- a/refs.bib
+++ b/refs.bib
@@ -1,1 +1,3 @@
 @book{knuth84}
+
+@article{x, title={T}}
diff --git a/intro.tex b/intro.tex
--- a/intro.tex
+++ b/intro.tex
@@ -1,3 +1,3 @@
 \\section{Introduction}
-Swarm robotics is a field of study.
+Swarm robotics studies groups of \\emph{simple} robots~\\cite{x}.
 We study coordination.
`;

describe('firstChange', () => {
  it('finds the first .tex change, its new line and the inserted words as printed', () => {
    expect(firstChange(PATCH)).toEqual({ path: 'intro.tex', line: 2, text: 'studies groups of simple robots' });
  });
  it('a citation alone points at the words before it', () => {
    const p = PATCH.replace('+Swarm robotics studies groups of \\emph{simple} robots~\\cite{x}.', '+Swarm robotics is a field of study~\\cite{x}.');
    expect(firstChange(p)?.text).toBe('a field of study');
  });
  it('no .tex change, no target', () => {
    expect(firstChange(PATCH.split('diff --git a/intro.tex')[0])).toBeNull();
  });
});

describe('latexToPlain', () => {
  it('keeps what prints', () => {
    expect(latexToPlain('as shown in~\\cite{a,b} and Fig.~\\ref{f}, \\textbf{bold} text -- with $x^2$ % note')).toBe('as shown in and Fig. , bold text – with');
  });
});
