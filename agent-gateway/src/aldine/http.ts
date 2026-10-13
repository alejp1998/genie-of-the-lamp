import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type AldineApi, AldineToolError, type Identity, type ProjectInfo, type ReviewComment, type ToolCallOptions } from './types.ts';

const SESSION_COOKIE = 'aldine_session';
const IDENTITY_TTL_MS = 10_000;
const TOKEN_TTL_MS = 60 * 60_000;
/** A token is replaced once less than this remains, so a run never outlives its credential. */
const TOKEN_MIN_REMAINING_MS = 15 * 60_000;
const LOCAL_USER = { id: 'local', name: 'Local user', email: null };

/** Keep only Aldine's session cookie: nothing else from the browser travels upstream. */
export function sessionCookie(header: string | undefined): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === SESSION_COOKIE) return `${SESSION_COOKIE}=${v.join('=')}`;
  }
  return '';
}

const digest = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

interface CachedToken { token: string; id: string | null; expiresAt: number }

export interface HttpAldineOptions {
  baseUrl: string;
  /** Agent label Aldine stamps on commits and presence, e.g. "Paper Assistant". */
  agentLabel: string;
  /** Operator token for Aldine deployments without auth (ALDINE_MCP_TOKEN). */
  operatorToken?: string;
  tokenName?: string;
  fetchImpl?: typeof fetch;
}

export class HttpAldine implements AldineApi {
  private opts: Required<Omit<HttpAldineOptions, 'operatorToken'>> & { operatorToken?: string };
  private identities = new Map<string, { at: number; value: Identity | null }>();
  private projects = new Map<string, { at: number; value: ProjectInfo | null }>();
  private tokens = new Map<string, CachedToken>();
  private minting = new Map<string, Promise<string>>();
  private clients = new Map<string, Promise<Client>>();

  constructor(opts: HttpAldineOptions) {
    this.opts = { tokenName: 'Paper Assistant (auto)', fetchImpl: fetch, ...opts };
  }

  private async rest(pathname: string, init: RequestInit & { cookie?: string; token?: string } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set('cookie', init.cookie);
    if (init.token) headers.set('authorization', `Bearer ${init.token}`);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    return this.opts.fetchImpl(this.opts.baseUrl + pathname, { ...init, headers });
  }

  async whoami(cookie: string): Promise<Identity | null> {
    const key = digest(cookie);
    const hit = this.identities.get(key);
    if (hit && Date.now() - hit.at < IDENTITY_TTL_MS) return hit.value;
    const res = await this.rest('/api/auth/me', { cookie });
    if (!res.ok) throw new Error(`Aldine /api/auth/me answered ${res.status}`);
    const me = await res.json() as { authEnabled: boolean; user: { id: string; name?: string; email?: string | null } | null };
    let value: Identity | null;
    if (!me.authEnabled) value = { authEnabled: false, user: LOCAL_USER, cookie };
    else if (!me.user) value = null;
    else value = { authEnabled: true, user: { id: me.user.id, name: me.user.name || me.user.email || 'Unnamed user', email: me.user.email ?? null }, cookie };
    this.identities.set(key, { at: Date.now(), value });
    return value;
  }

  async project(identity: Identity, projectId: string): Promise<ProjectInfo | null> {
    const key = `${identity.user.id}:${projectId}:${digest(identity.cookie)}`;
    const hit = this.projects.get(key);
    if (hit && Date.now() - hit.at < IDENTITY_TTL_MS) return hit.value;
    // Aldine's own access check, run with the requester's session, is the source of truth.
    const res = await this.rest(`/api/projects/${encodeURIComponent(projectId)}`, { cookie: identity.cookie });
    let value: ProjectInfo | null = null;
    if (res.ok) {
      const p = await res.json() as { id: string; name: string; rootFile?: string | null; branches?: (string | { name: string })[] };
      value = { id: p.id, name: p.name, rootFile: p.rootFile ?? null, branches: (p.branches ?? []).map((b) => (typeof b === 'string' ? b : b.name)) };
    } else if (res.status !== 401 && res.status !== 403 && res.status !== 404) {
      throw new Error(`Aldine project lookup answered ${res.status}`);
    }
    this.projects.set(key, { at: Date.now(), value });
    return value;
  }

  async credential(identity: Identity, projectId: string): Promise<string> {
    if (!identity.authEnabled) {
      if (!this.opts.operatorToken) throw new Error('Aldine runs without auth; set ALDINE_MCP_TOKEN so the gateway can reach /mcp');
      return this.opts.operatorToken;
    }
    const key = `${identity.user.id}:${projectId}`;
    const cur = this.tokens.get(key);
    if (cur && cur.expiresAt - Date.now() > TOKEN_MIN_REMAINING_MS) return cur.token;
    const inflight = this.minting.get(key);
    if (inflight) return inflight;
    const p = this.mint(identity, projectId, cur).finally(() => this.minting.delete(key));
    this.minting.set(key, p);
    return p;
  }

  private async mint(identity: Identity, projectId: string, previous: CachedToken | undefined): Promise<string> {
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    const res = await this.rest('/api/tokens', {
      method: 'POST',
      cookie: identity.cookie,
      body: JSON.stringify({ name: this.opts.tokenName, projectIds: [projectId], expiresAt: new Date(expiresAt).toISOString() }),
    });
    if (!res.ok) throw new Error(`Aldine refused to issue an assistant credential (${res.status})`);
    const body = await res.json() as { token: string; id?: string };
    this.tokens.set(`${identity.user.id}:${projectId}`, { token: body.token, id: body.id ?? null, expiresAt });
    if (previous) {
      this.dropClient(previous.token);
      // Best effort: an expired token is already inert, this only keeps the user's token list short.
      if (previous.id) this.rest(`/api/tokens/${encodeURIComponent(previous.id)}`, { method: 'DELETE', cookie: identity.cookie }).catch(() => {});
    }
    return body.token;
  }

  private client(token: string): Promise<Client> {
    let c = this.clients.get(token);
    if (!c) {
      c = (async () => {
        const transport = new StreamableHTTPClientTransport(new URL(this.opts.baseUrl + '/mcp'), {
          requestInit: { headers: { authorization: `Bearer ${token}`, 'x-aldine-agent-label': this.opts.agentLabel } },
        });
        const client = new Client({ name: 'genie-agent-gateway', version: '0.1.0' });
        await client.connect(transport);
        return client;
      })();
      c.catch(() => this.clients.delete(token));
      this.clients.set(token, c);
    }
    return c;
  }

  private dropClient(token: string) {
    const c = this.clients.get(token);
    this.clients.delete(token);
    c?.then((cl) => cl.close()).catch(() => {});
  }

  async callTool(token: string, name: string, args: Record<string, unknown>, opts: ToolCallOptions = {}): Promise<any> {
    let result;
    try {
      const client = await this.client(token);
      result = await client.callTool({ name, arguments: args }, undefined, {
        signal: opts.signal,
        timeout: opts.timeoutMs,
        resetTimeoutOnProgress: true,
        // Aldine only sends progress (keeping long compiles alive) when the caller asks for it.
        onprogress: () => {},
      });
    } catch (err) {
      this.dropClient(token);
      throw err;
    }
    const first = Array.isArray(result.content) ? result.content.find((c: any) => c.type === 'text') : undefined;
    const text: string = first ? (first as { text: string }).text : '';
    if (result.isError) throw new AldineToolError(text || `${name} failed`);
    try { return JSON.parse(text); } catch { return text; }
  }

  async listComments(token: string, projectId: string, branch: string): Promise<ReviewComment[]> {
    const res = await this.rest(`/api/projects/${encodeURIComponent(projectId)}/comments?branch=${encodeURIComponent(branch)}`, { token });
    if (!res.ok) throw new Error(`Aldine comments answered ${res.status}`);
    return res.json() as Promise<ReviewComment[]>;
  }

  async replyComment(token: string, projectId: string, commentId: string, body: string): Promise<void> {
    const res = await this.rest(`/api/projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(commentId)}/reply`, {
      method: 'POST', token, headers: { 'x-aldine-agent-label': this.opts.agentLabel }, body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`Aldine refused the reply (${res.status})`);
  }

  async resolveComment(token: string, projectId: string, commentId: string): Promise<void> {
    const res = await this.rest(`/api/projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(commentId)}/resolve`, { method: 'POST', token, body: JSON.stringify({ resolved: true }) });
    if (!res.ok) throw new Error(`Aldine refused to resolve the comment (${res.status})`);
  }

  async readBinary(token: string, projectId: string, branch: string, path: string): Promise<{ mediaType: string; data: Buffer } | null> {
    const res = await this.rest(`/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}&branch=${encodeURIComponent(branch)}`, { token });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Aldine file read answered ${res.status}`);
    return { mediaType: (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0], data: Buffer.from(await res.arrayBuffer()) };
  }

  async compileStatus(token: string, projectId: string, branch: string): Promise<any> {
    const res = await this.rest(`/api/projects/${encodeURIComponent(projectId)}/compile-status?branch=${encodeURIComponent(branch)}`, { token });
    if (!res.ok) throw new Error(`Aldine compile-status answered ${res.status}`);
    return res.json();
  }
}
