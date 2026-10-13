import { useCallback, useEffect, useImperativeHandle, forwardRef, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import { shortcut } from '../platform';
import { findInRegion, findMatches, type Match, type PageText, type Region } from './pdfFind';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

export interface PdfPaneHandle {
  /**
   * Scroll to a page + PDF-space y and flash a highlight (forward SyncTeX).
   * With `text`, only that text is flashed: its `occurrence`-th match inside
   * `region` (the boxes the source line typeset to); otherwise the band.
   */
  showForward(page: number, y: number, h?: number, target?: { region?: Region; text?: string | null; occurrence?: number }): void;
  /** Opens the find bar (Ctrl/Cmd+F while the preview has focus does the same). */
  openFind(): void;
}

interface Props {
  pdfUrl: string | null;
  /** The branch whose PDF is shown; a change empties the pane (see below). */
  branch?: string;
  status: 'idle' | 'compiling' | 'ok' | 'error';
  zoom?: number; // multiplier on fit-width (1 = fit width)
  /** Whether the failed compile produced actual parsed errors — gates the "fix the errors" copy. */
  hasErrors?: boolean;
  /** The last run failed: whatever is on screen is from the last successful typeset. */
  stale?: boolean;
  /** onFirstOpen waits for this: the parent knows what the project holds only
   *  after its file listing arrives. */
  ready?: boolean;
  /** No .tex on the branch: the idle copy must not invite a typeset that
   *  would only fail. */
  hasTex?: boolean;
  onFirstOpen(): void;
  /** Inverse SyncTeX: user double-clicked at (page, pdfX, pdfY) in PDF points. */
  onInverse?(page: number, x: number, y: number): void;
  /** A PDF finished rendering (a new typeset is on screen). */
  onRendered?(): void;
}

const PdfPane = forwardRef<PdfPaneHandle, Props>(function PdfPane({ pdfUrl, branch, status, zoom = 1, hasErrors = false, stale = false, ready = true, hasTex = true, onFirstOpen, onInverse, onRendered }, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const renderTask = useRef(0);
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;
  const firstOpenFired = useRef(false);
  // per-page viewport info for coordinate mapping
  const pageInfo = useRef<Array<{ el: HTMLCanvasElement; scale: number; height: number }>>([]);

  // ---- find in PDF ----
  const docRef = useRef<Awaited<ReturnType<typeof pdfjs.getDocument>['promise']> | null>(null);
  const textRef = useRef<{ url: string | null; pages: Promise<PageText[]> | null }>({ url: null, pages: null });
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Match[]>([]);
  const [current, setCurrent] = useState(0);
  const [layoutGen, setLayoutGen] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);

  const pageTexts = useCallback((): Promise<PageText[]> => {
    const doc = docRef.current;
    if (!doc) return Promise.resolve([]);
    if (textRef.current.url !== pdfUrl || !textRef.current.pages) {
      textRef.current = {
        url: pdfUrl,
        pages: (async () => {
          const out: PageText[] = [];
          for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const tc = await page.getTextContent();
            out.push({ view: page.view, items: tc.items.filter((it): it is typeof it & { str: string } => 'str' in it) as unknown as PageText['items'] });
          }
          return out;
        })(),
      };
    }
    return textRef.current.pages!;
  }, [pdfUrl]);

  // Re-run on a new PDF (each typeset) and when the query changes.
  useEffect(() => {
    if (!findOpen || !query.trim() || !rendered) { setMatches([]); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      pageTexts().then((pages) => {
        if (cancelled) return;
        const m = findMatches(pages, query);
        setMatches(m);
        setCurrent((c) => (c < m.length ? c : 0));
      }).catch(() => {});
    }, 120);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, findOpen, rendered, pdfUrl, pageTexts]);

  // Draw hits over the canvases; redrawn after every layout (zoom, new PDF).
  useEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    inner.querySelectorAll('.pdf-hit').forEach((el) => el.remove());
    if (!findOpen) return;
    matches.forEach((m, i) => {
      const info = pageInfo.current[m.page - 1];
      if (!info) return;
      for (const r of m.rects) {
        const hit = document.createElement('div');
        hit.className = `pdf-hit${i === current ? ' pdf-hit--current' : ''}`;
        hit.style.left = `${info.el.offsetLeft + r.left * info.scale}px`;
        hit.style.top = `${info.el.offsetTop + r.top * info.scale}px`;
        hit.style.width = `${r.width * info.scale}px`;
        hit.style.height = `${r.height * info.scale}px`;
        inner.appendChild(hit);
      }
    });
  }, [matches, current, findOpen, layoutGen]);

  const goTo = useCallback((i: number) => {
    if (!matches.length) return;
    const n = (i + matches.length) % matches.length;
    setCurrent(n);
    const m = matches[n];
    const info = pageInfo.current[m.page - 1];
    const scroller = scrollRef.current;
    if (info && scroller) scroller.scrollTo({ top: info.el.offsetTop + m.rects[0].top * info.scale - scroller.clientHeight / 3, behavior: 'smooth' });
  }, [matches]);
  useEffect(() => { if (matches.length) goTo(current); }, [matches]); // first hit comes into view

  const openFind = useCallback(() => {
    setFindOpen(true);
    requestAnimationFrame(() => { findInput.current?.focus(); findInput.current?.select(); });
  }, []);

  useImperativeHandle(ref, () => ({
    showForward(page, y, h = 12, target) {
      const info = pageInfo.current[page - 1];
      const scroller = scrollRef.current;
      if (!info || !scroller) return;
      const flashAt = (rects: { left: number; top: number; width: number; height: number }[]) => {
        for (const r of rects) {
          const el = document.createElement('div');
          el.className = 'pdf-flash';
          el.style.left = `${info.el.offsetLeft + r.left * info.scale - 2}px`;
          el.style.top = `${info.el.offsetTop + r.top * info.scale - 1}px`;
          el.style.width = `${r.width * info.scale + 4}px`;
          el.style.height = `${r.height * info.scale + 2}px`;
          innerRef.current?.appendChild(el);
          setTimeout(() => el.remove(), 1100);
        }
      };
      const band = () => {
        scroller.scrollTo({ top: info.el.offsetTop + y * info.scale - scroller.clientHeight / 3, behavior: 'smooth' });
        const r = target?.region;
        flashAt([r
          ? { left: r.left, top: r.top, width: r.right - r.left, height: Math.max(r.bottom - r.top, 8) }
          : { left: 0, top: y - h, width: info.el.clientWidth / info.scale, height: Math.max(16 / info.scale, h * 2) }]);
      };
      if (!target?.text || !target.region) { band(); return; }
      const { text, region, occurrence } = target;
      pageTexts().then((pages) => {
        const words = text.split(' ').filter(Boolean);
        const longest = [...words].sort((a, b) => b.length - a.length)[0] ?? '';
        const tries = [...new Set([text, words.slice(0, 6).join(' '), words.slice(0, 3).join(' '), longest.length >= 4 ? longest : ''])].filter(Boolean);
        let m: Match | null = null;
        for (const t of tries) if (pages[page - 1] && (m = findInRegion(pages[page - 1], t, region, t === text ? occurrence ?? 1 : 1, page))) break;
        if (!m) { band(); return; }
        scroller.scrollTo({ top: info.el.offsetTop + m.rects[0].top * info.scale - scroller.clientHeight / 3, behavior: 'smooth' });
        flashAt(m.rects);
      }, band);
    },
    openFind,
  }), [openFind, pageTexts]);

  // auto-typeset once when the pane first mounts with no pdf
  useEffect(() => {
    if (!firstOpenFired.current && ready && !pdfUrl && status === 'idle') {
      firstOpenFired.current = true;
      onFirstOpen();
    }
  }, [pdfUrl, status, ready, onFirstOpen]);

  // Zoom clicks arrive in bursts; debounce so three +10% clicks trigger one
  // re-layout instead of three full render passes.
  const [layoutZoom, setLayoutZoom] = useState(zoom);
  useEffect(() => {
    // The click itself must show: stretch the pages already on screen to the
    // new size at once, and let the debounced pass below redraw them sharp.
    const ratio = zoom / layoutZoom;
    for (const { el } of pageInfo.current) {
      const w = Number(el.dataset.w), h = Number(el.dataset.h);
      if (w && h) { el.style.width = `${Math.floor(w * ratio)}px`; el.style.height = `${Math.floor(h * ratio)}px`; }
    }
    const t = setTimeout(() => setLayoutZoom(zoom), 150);
    return () => clearTimeout(t);
  }, [zoom]);

  // A branch switch nulls pdfUrl, which alone never touches the canvases —
  // the pane would keep showing the previous branch's pages, and a failed
  // typeset on the new branch would label them as its last successful one.
  useEffect(() => {
    renderTask.current++;
    innerRef.current?.replaceChildren();
    pageInfo.current = [];
    setRendered(false);
  }, [branch]);

  useEffect(() => {
    if (!pdfUrl || !innerRef.current) return;
    const my = ++renderTask.current;
    const container = innerRef.current;
    const scroller = scrollRef.current!;
    const prevScroll = scroller.scrollTop;
    let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']> | null = null;
    let observer: IntersectionObserver | null = null;

    // Virtualized rendering: every page gets a correctly-sized canvas
    // immediately (layout only — getViewport, no rasterization), so scroll
    // geometry, SyncTeX offsets, and test selectors are all valid from the
    // start. Pixels are rasterized only for pages near the viewport; far
    // offscreen pages release their backing store (a 100-page paper would
    // otherwise hold ~660 MB of RGBA at zoom 1, gigabytes when zoomed).
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const states = new Map<number, 'blank' | 'rendering' | 'done'>();
    let chain: Promise<void> = Promise.resolve(); // serialize worker renders

    const rasterize = (i: number) => {
      if (states.get(i) === 'rendering' || states.get(i) === 'done') return;
      states.set(i, 'rendering');
      chain = chain.then(async () => {
        if (my !== renderTask.current || !doc) return;
        const info = pageInfo.current[i - 1];
        if (!info) return;
        try {
          const page = await doc.getPage(i);
          if (my !== renderTask.current) return;
          const viewport = page.getViewport({ scale: info.scale });
          const canvas = info.el;
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          const cctx = canvas.getContext('2d')!;
          cctx.scale(dpr, dpr);
          await page.render({ canvasContext: cctx, viewport }).promise;
          if (my === renderTask.current) states.set(i, 'done');
        } catch (err) {
          states.set(i, 'blank');
          if ((err as { name?: string })?.name !== 'RenderingCancelledException') console.error('[pdf] page render failed', err);
        }
      });
    };

    const release = (i: number) => {
      if (states.get(i) !== 'done') return;
      const info = pageInfo.current[i - 1];
      if (!info) return;
      // Zero the backing store (frees the bitmap); CSS size stays, so layout,
      // offsets, and visibility checks are untouched.
      info.el.width = 0;
      info.el.height = 0;
      states.set(i, 'blank');
    };

    (async () => {
      try {
        doc = await pdfjs.getDocument(pdfUrl).promise;
        if (my !== renderTask.current) { try { doc.destroy(); } catch { /* noop */ } return; }
        docRef.current = doc;
        const width = Math.max(320, scroller.clientWidth - 36) * layoutZoom;
        const frag = document.createDocumentFragment();
        const info: Array<{ el: HTMLCanvasElement; scale: number; height: number }> = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          if (my !== renderTask.current) return;
          const base = page.getViewport({ scale: 1 });
          const scale = width / base.width;
          const canvas = document.createElement('canvas');
          canvas.className = 'pdf-page';
          canvas.dataset.page = String(i);
          canvas.dataset.w = String(Math.floor(base.width * scale));
          canvas.dataset.h = String(Math.floor(base.height * scale));
          canvas.style.width = `${canvas.dataset.w}px`;
          canvas.style.height = `${canvas.dataset.h}px`;
          canvas.style.background = '#fff';
          frag.appendChild(canvas);
          info.push({ el: canvas, scale, height: base.height });
          states.set(i, 'blank');
        }
        if (my !== renderTask.current) return;
        container.replaceChildren(frag);
        pageInfo.current = info;
        setLayoutGen((g) => g + 1);
        scroller.scrollTop = prevScroll;

        // First visible page rasterizes before the spinner goes away — no
        // flash of blank paper on open.
        rasterize(1);
        await chain;
        if (my !== renderTask.current) return;
        setRendered(true);
        onRenderedRef.current?.();

        observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            const i = Number((entry.target as HTMLElement).dataset.page);
            if (!i) continue;
            if (entry.isIntersecting) rasterize(i);
            else release(i);
          }
        }, { root: scroller, rootMargin: '150% 0px' });
        for (const { el } of info) observer.observe(el);
      } catch (err) {
        // a superseded render (fast retyping) cancels itself — that's expected, not an error
        if ((err as { name?: string })?.name !== 'RenderingCancelledException') console.error('[pdf] render failed', err);
      }
    })();
    // Invalidate any in-flight render (so its guarded loop bails before touching
    // the DOM/state) and release the pdf.js document — each compile is a unique
    // URL, so without this the worker's document memory accretes every typeset.
    return () => {
      renderTask.current++;
      observer?.disconnect();
      Promise.resolve(doc).then((d) => { try { d?.destroy(); } catch { /* already gone */ } });
    };
  }, [pdfUrl, layoutZoom]);

  const handleDblClick = (e: React.MouseEvent) => {
    if (!onInverse) return;
    // closest() instead of an instanceof check: works whatever element ends up
    // on top (canvas, flash overlay remnants, future wrappers).
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-page]');
    if (!target?.dataset.page) return;
    const idx = Number(target.dataset.page) - 1;
    const info = pageInfo.current[idx];
    if (!info) return;
    const rect = target.getBoundingClientRect();
    const x = (e.clientX - rect.left) / info.scale;
    const y = (e.clientY - rect.top) / info.scale;
    onInverse(idx + 1, x, y);
  };

  return (
    <div
      className="pdf-pane"
      ref={scrollRef}
      data-testid="pdf-pane"
      tabIndex={-1}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); }
      }}
    >
      {findOpen && (
        <div className="pdf-find" role="search" data-testid="pdf-find">
          <input
            ref={findInput}
            className="input pdf-find__input"
            value={query}
            placeholder="Find in PDF"
            aria-label="Find in PDF"
            data-testid="pdf-find-input"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); goTo(current + (e.shiftKey ? -1 : 1)); }
              else if (e.key === 'Escape') { e.preventDefault(); setFindOpen(false); scrollRef.current?.focus(); }
            }}
          />
          <span className="pdf-find__count" data-testid="pdf-find-count">{query.trim() ? (matches.length ? `${current + 1} of ${matches.length}` : 'No results') : ''}</span>
          <button className="btn btn--ghost btn--small" onClick={() => goTo(current - 1)} disabled={!matches.length} aria-label="Previous match" title="Previous (Shift+Enter)">↑</button>
          <button className="btn btn--ghost btn--small" onClick={() => goTo(current + 1)} disabled={!matches.length} aria-label="Next match" title="Next (Enter)">↓</button>
          <button className="btn btn--ghost btn--small" onClick={() => setFindOpen(false)} aria-label="Close find">×</button>
        </div>
      )}
      {stale && rendered && (
        <div className="pdf-stale" data-testid="pdf-stale">Preview is from the last successful typeset</div>
      )}
      <div className="pdf-pane__inner" ref={innerRef} onDoubleClick={handleDblClick} title={onInverse ? 'Double-click to jump to source' : undefined} />
      {!rendered && (
        <div className="pdf-empty">
          {status === 'compiling' ? (
            <><span className="spinner" /><p>Typesetting your document…</p></>
          ) : status === 'error' ? (
            // Only blame the document when there are errors to fix — a failed
            // run without parsed errors (missing root, server trouble) isn't
            // the user's LaTeX.
            <p>{hasErrors ? 'Fix the errors on the left, then typeset again.' : 'Typesetting didn’t finish — open the log for details.'}</p>
          ) : ready && !hasTex ? (
            <p data-testid="pdf-empty-no-tex">Create a .tex file to typeset and preview.</p>
          ) : (
            <p>Press <span className="kbd">{shortcut('S')}</span> to typeset and preview.</p>
          )}
        </div>
      )}
    </div>
  );
});

export default PdfPane;
