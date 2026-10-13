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
    const head = { branch: args.branch ?? 'main', head: 'abc1234' };
    switch (name) {
      case 'project_structure':
        return { files: Object.entries(this.files).map(([path, c]) => ({ path, type: 'file', size: c.length })), rootFile: 'main.tex', engine: 'pdflatex', contentVersion: 7, ...head };
      case 'read_file': {
        const path = String(args.path);
        const c = this.files[path];
        if (c === undefined) throw new AldineToolError(`No file at ${path}. Call project_structure to see the files.`);
        const lines = c.split('\n');
        if (args.from_line || args.to_line) {
          const from = Number(args.from_line ?? 1);
          const to = Math.min(Number(args.to_line ?? lines.length), lines.length);
          return { content: lines.slice(from - 1, to).join('\n'), totalLines: lines.length, from_line: from, to_line: to, path, contentVersion: 7, fileVersion: 3, ...head };
        }
        return { content: c, totalLines: lines.length, path, contentVersion: 7, fileVersion: 3, ...head };
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

  async compileStatus(): Promise<any> {
    return { running: false, finishedAt: '2026-10-13T10:00:00Z', result: { ok: false, errors: [{ type: 'error', file: 'intro.tex', line: 2, message: 'Undefined control sequence.' }], durationMs: 1500 } };
  }
}

export function testConfig(overrides: Partial<Config['limits']> = {}): Config {
  const c = loadConfig({ AGENT_ENABLE_MOCK: '1', AGENT_DEFAULT_PROVIDER: 'mock', AGENT_GATEWAY_BASE_PATH: '/agent-gateway' });
  c.limits = { ...c.limits, ...overrides };
  return c;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
