import { type AldineApi, AldineToolError, type Identity, type ProjectInfo } from '../src/aldine/types.ts';
import { type Config, loadConfig } from '../src/config.ts';

export const FILES: Record<string, string> = {
  'main.tex': '\\documentclass{article}\n\\begin{document}\n\\input{intro}\nSee Section~\\ref{sec:intro}.\n\\cite{knuth84}\n\\end{document}\n',
  'intro.tex': '\\section{Introduction}\\label{sec:intro}\nSwarm robotics is a field of study.\nWe study multi-robot coordination.\n',
  'refs.bib': '@book{knuth84, title={The TeXbook}, author={Knuth, Donald}, year={1984}}\n',
};

const USERS: Record<string, { id: string; name: string; email: string }> = {
  alice: { id: 'u-alice', name: 'Alice', email: 'alice@example.org' },
  bob: { id: 'u-bob', name: 'Bob', email: 'bob@example.org' },
  carol: { id: 'u-carol', name: 'Carol', email: 'carol@example.org' },
};

/** In-memory Aldine: alice and bob share project p1, carol has no access to it. */
export class FakeAldine implements AldineApi {
  files: Record<string, string> = { ...FILES };
  calls: { token: string; name: string; args: Record<string, unknown> }[] = [];
  credentials = 0;
  compileOk = false;
  /** Milliseconds every tool call takes; lets tests cancel mid-call. */
  delayMs = 0;
  /** Whole-file reads above this many bytes are refused, as Aldine's ~100 KB cap does. */
  readCapBytes = Infinity;
  /** Paths whose reads always fail. */
  broken = new Set<string>();
  /** Per-branch content version and the version each file last changed at (Aldine's optimistic-concurrency counters). */
  contentVersion = 7;
  fileVersions: Record<string, number> = {};
  commits: { hash: string; message: string; files: string[]; token: string }[] = [];
  head = 'abc1234';

  /** A collaborator typing: changes the file and bumps the versions, like a live edit would. */
  collaboratorEdit(path: string, next: string) {
    this.files[path] = next;
    this.contentVersion++;
    this.fileVersions[path] = this.contentVersion;
  }

  async whoami(cookie: string): Promise<Identity | null> {
    const name = cookie.replace(/^aldine_session=/, '');
    const u = USERS[name];
    return u ? { authEnabled: true, user: u, cookie } : null;
  }

  async project(identity: Identity, projectId: string): Promise<ProjectInfo | null> {
    if (projectId !== 'p1' || identity.user.id === 'u-carol') return null;
    return { id: 'p1', name: 'Swarm paper', rootFile: 'main.tex', branches: ['main', 'draft'] };
  }

  async credential(identity: Identity, projectId: string): Promise<string> {
    this.credentials++;
    return `tok-${identity.user.id}-${projectId}`;
  }

  async callTool(token: string, name: string, args: Record<string, unknown>, opts: { signal?: AbortSignal } = {}): Promise<any> {
    this.calls.push({ token, name, args });
    if (this.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.delayMs);
        opts.signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
      });
    }
    const head = { branch: args.branch ?? 'main', head: this.head };
    const fv = (p: string) => this.fileVersions[p] ?? 3;
    switch (name) {
      case 'project_structure':
        return { files: Object.entries(this.files).map(([path, c]) => ({ path, type: 'file', size: c.length })), rootFile: 'main.tex', engine: 'pdflatex', contentVersion: 7, ...head };
      case 'read_file': {
        const path = String(args.path);
        const c = this.files[path];
        if (c === undefined) throw new AldineToolError(`No file at ${path}. Call project_structure to see the files.`);
        if (this.broken.has(path)) throw new AldineToolError(`${path} is a binary file.`);
        const lines = c.split('\n');
        if (args.from_line || args.to_line) {
          const from = Number(args.from_line ?? 1);
          const to = Math.min(Number(args.to_line ?? lines.length), lines.length);
          return { content: lines.slice(from - 1, to).join('\n'), totalLines: lines.length, from_line: from, to_line: to, path, contentVersion: this.contentVersion, fileVersion: fv(path), ...head };
        }
        if (c.length > this.readCapBytes) throw new AldineToolError(`That read is ${c.length} bytes — cap is ~100 KB. The file has ${lines.length} lines; read it in windows with from_line/to_line.`);
        return { content: c, totalLines: lines.length, path, contentVersion: this.contentVersion, fileVersion: fv(path), ...head };
      }
      case 'batch_write': {
        const files = args.files as { path: string; content?: string; edits?: { quote: string; replacement: string; occurrence?: number }[]; base_version?: number }[];
        const next: Record<string, string> = {};
        for (const f of files) {
          if (f.base_version !== undefined && !(fv(f.path) <= f.base_version && f.base_version <= this.contentVersion)) {
            return { error: 'version_conflict', currentVersion: this.contentVersion, fileVersion: fv(f.path), reason: 'file changed', ...head };
          }
          if (f.content !== undefined) { next[f.path] = f.content; continue; }
          let c = this.files[f.path];
          if (c === undefined) throw new AldineToolError(`No file at ${f.path}.`);
          for (const e of [...f.edits!].reverse()) {
            const hits: number[] = [];
            for (let at = c.indexOf(e.quote); at >= 0; at = c.indexOf(e.quote, at + 1)) hits.push(at);
            if (!hits.length) return { error: 'stale_anchor', edit_index: 0, reason: 'not found', candidates: [], ...head };
            if (hits.length > 1 && !e.occurrence) return { error: 'ambiguous_anchor', edit_index: 0, reason: 'ambiguous', candidates: [], ...head };
            const at = hits[(e.occurrence ?? 1) - 1];
            c = c.slice(0, at) + e.replacement + c.slice(at + e.quote.length);
          }
          next[f.path] = c;
        }
        this.contentVersion++;
        for (const [p2, c] of Object.entries(next)) { this.files[p2] = c; this.fileVersions[p2] = this.contentVersion; }
        const hash = Math.random().toString(16).slice(2, 9);
        this.commits.push({ hash, message: String(args.message), files: Object.keys(next), token });
        this.head = hash;
        return { ok: true, paths: Object.keys(next), contentVersion: this.contentVersion, commit: hash, branch: head.branch, head: hash };
      }
      case 'references_add': {
        const q = String(args.query);
        this.refsAdded.push(q);
        if (q === 'fail') throw new AldineToolError('lookup failed');
        return { key: `ref${this.refsAdded.length}`, bibFile: args.bibFile ?? 'refs.bib', duplicate: false, created: false, ...head };
      }
      case 'compile':
        return this.compileOk
          ? { ok: true, errors: [], errorsTotal: 0, warningsTotal: 0, durationMs: 1800, pages: 2, ...head }
          : { ok: false, errors: [{ type: 'error', file: 'intro.tex', line: 2, message: 'Undefined control sequence.' }], errorsTotal: 1, warningsTotal: 0, durationMs: 1500, ...head };
      case 'list_citations':
        return { citations: [{ key: 'knuth84', title: 'The TeXbook', author: 'Knuth, Donald', year: '1984', file: 'refs.bib' }], ...head };
      case 'list_labels':
        return { labels: [{ label: 'sec:intro', file: 'intro.tex' }], ...head };
      default:
        throw new AldineToolError(`Unknown tool ${name}`);
    }
  }

  comments: any[] = [];
  refsAdded: string[] = [];
  replies: { id: string; body: string }[] = [];

  async listComments() { return structuredClone(this.comments); }
  async replyComment(_t: string, _p: string, id: string, body: string) {
    const c = this.comments.find((x) => x.id === id);
    if (!c) throw new Error('comment not found');
    c.replies.push({ author: 'Alice (via Paper Assistant)', body });
    this.replies.push({ id, body });
  }
  async resolveComment(_t: string, _p: string, id: string) {
    const c = this.comments.find((x) => x.id === id);
    if (!c) throw new Error('comment not found');
    c.resolved = true;
  }

  binaries: Record<string, { mediaType: string; data: Buffer }> = {
    'figures/robot.png': { mediaType: 'image/png', data: Buffer.from('89504e470d0a1a0a00000000', 'hex') },
  };

  async readBinary(_token: string, _projectId: string, _branch: string, path: string) {
    return this.binaries[path] ?? null;
  }

  async compileStatus(): Promise<any> {
    return { running: false, finishedAt: '2026-10-13T10:00:00Z', result: { ok: false, errors: [{ type: 'error', file: 'intro.tex', line: 2, message: 'Undefined control sequence.' }], durationMs: 1500 } };
  }
}

export function testConfig(overrides: Partial<Config['limits']> = {}): Config {
  const c = loadConfig({ AGENT_ENABLE_MOCK: '1', AGENT_DEFAULT_PROVIDER: 'mock', AGENT_GATEWAY_BASE_PATH: '/agent-gateway' });
  c.limits = { ...c.limits, ...overrides };
  // No network in unit tests: research tests build their own config against a local mock.
  c.research = { ...c.research, enabled: false };
  return c;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
