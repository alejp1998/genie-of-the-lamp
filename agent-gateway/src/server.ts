import crypto from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Attachment, ClientContext, MAX_IMAGES, MAX_PDFS } from './agent/context.ts';
import { sessionCookie } from './aldine/http.ts';
import type { AldineApi, Identity, ProjectInfo } from './aldine/types.ts';
import type { Config, ModelRef } from './config.ts';
import type { Block } from './providers/types.ts';
import { acceptProposal, ProposalError, rejectProposal } from './patches/apply.ts';
import { BusyError, type RunManager } from './runs.ts';
import type { Proposal, Session, Store, StoredMessage } from './store/types.ts';

declare module 'fastify' {
  interface FastifyRequest { identity: Identity | null }
  interface FastifyContextConfig { public?: boolean }
}

const SSE_HEARTBEAT_MS = 15_000;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

const SendBody = z.object({
  text: z.string().trim().min(1),
  context: ClientContext,
  model: z.string().max(200).optional(),
  attachments: z.array(Attachment).max(12).optional(),
}).strict();

/** Room for a few pasted screenshots; every other route keeps the small default. */
const MESSAGE_BODY_LIMIT = 48 * 1024 * 1024;

const AcceptBody = z.object({
  edits: z.array(z.object({ change: z.number().int().min(0), edit: z.number().int().min(0), replacement: z.string().max(50_000) }).strict()).max(500).optional(),
  contents: z.array(z.object({ change: z.number().int().min(0), content: z.string().max(200_000) }).strict()).max(20).optional(),
}).strict();

const PatchBody = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  visibility: z.enum(['private', 'project']).optional(),
}).strict();

const modelId = (m: ModelRef) => `${m.provider}:${m.model}`;

/** Reasoning signatures and other provider internals never leave the gateway; images are fetched separately. */
function publicBlocks(messageId: number, blocks: Block[]): unknown[] {
  return blocks.map((b, i) => {
    if (b.type === 'opaque') return { type: 'opaque' };
    if (b.type === 'image') return { type: 'image', mediaType: b.mediaType, name: b.name, ref: `${messageId}/${i}` };
    if (b.type === 'document') return { type: 'document', mediaType: b.mediaType, name: b.name, ref: `${messageId}/${i}`, hasText: !!b.text };
    if (b.type === 'tool_result' && b.images?.length) return { ...b, images: b.images.map((im, k) => ({ mediaType: im.mediaType, ref: `${messageId}/${i}/${k}` })) };
    return b;
  });
}

function publicMessage(m: StoredMessage) {
  return { id: m.id, runId: m.runId, role: m.role, blocks: publicBlocks(m.id, m.blocks), createdAt: m.createdAt };
}

function publicSession(s: Session, viewer: Identity) {
  return { ...s, isOwner: s.ownerId === viewer.user.id };
}

export interface AppDeps {
  config: Config;
  store: Store;
  aldine: AldineApi;
  runs: RunManager;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, store, aldine, runs } = deps;
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] },
    bodyLimit: 256 * 1024,
    trustProxy: process.env.TRUST_PROXY === '1',
  });
  app.decorateRequest('identity', null);

  app.addHook('onRequest', async (req, reply) => {
    if (req.routeOptions.config?.public) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // A custom header forces a CORS preflight for any cross-origin attempt; Sec-Fetch-Site catches the rest.
      if (req.headers['x-aladine-request'] !== '1') return reply.code(403).send({ error: 'Request rejected: missing X-Aladine-Request header' });
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') return reply.code(403).send({ error: 'Request rejected: cross-site requests are not allowed' });
    }
    let identity: Identity | null;
    try {
      identity = await aldine.whoami(sessionCookie(req.headers.cookie));
    } catch (err) {
      req.log.error({ err }, 'aldine identity lookup failed');
      return reply.code(502).send({ error: 'Could not reach Aldine to check your sign-in' });
    }
    if (!identity) return reply.code(401).send({ error: 'Sign in to Aldine to use the assistant' });
    req.identity = identity;
  });

  async function projectOr404(req: FastifyRequest, reply: FastifyReply, projectId: string): Promise<ProjectInfo | null> {
    if (!ID_RE.test(projectId)) { reply.code(404).send({ error: 'Project not found' }); return null; }
    const p = await aldine.project(req.identity!, projectId);
    if (!p) { reply.code(404).send({ error: 'Project not found, or you do not have access to it' }); return null; }
    return p;
  }

  /** A session is visible to its owner, and to project members once shared; anyone else gets a 404. */
  async function sessionFor(req: FastifyRequest, reply: FastifyReply, sid: string, mode: 'view' | 'own') {
    const s = ID_RE.test(sid) ? store.getSession(sid) : null;
    const me = req.identity!;
    const isOwner = !!s && s.ownerId === me.user.id;
    if (!s || (!isOwner && s.visibility !== 'project')) { reply.code(404).send({ error: 'Chat session not found' }); return null; }
    const project = await projectOr404(req, reply, s.projectId);
    if (!project) return null;
    if (mode === 'own' && !isOwner) { reply.code(403).send({ error: 'Only the person who started this chat can do that; shared chats are read-only' }); return null; }
    return { session: s, project, isOwner };
  }

  const base = config.basePath;

  app.get(`${base}/health`, { config: { public: true } }, async () => ({ ok: true }));

  app.get(`${base}/config`, async (req) => ({
    agentLabel: config.agentLabel,
    user: { id: req.identity!.user.id, name: req.identity!.user.name },
    authEnabled: req.identity!.authEnabled,
    models: config.models.map((m) => ({ id: modelId(m), label: m.label, provider: m.provider })),
    defaultModel: modelId(config.defaultModel),
    limits: { maxMessageChars: config.limits.maxMessageChars, maxIterations: config.limits.maxIterations },
  }));

  app.get<{ Params: { pid: string } }>(`${base}/projects/:pid/sessions`, async (req, reply) => {
    const project = await projectOr404(req, reply, req.params.pid);
    if (!project) return;
    return { sessions: store.listSessions(project.id, req.identity!.user.id).map((s) => publicSession(s, req.identity!)) };
  });

  app.post<{ Params: { pid: string }; Body: { title?: string } }>(`${base}/projects/:pid/sessions`, async (req, reply) => {
    const project = await projectOr404(req, reply, req.params.pid);
    if (!project) return;
    const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim().slice(0, 120) : 'New chat';
    const me = req.identity!;
    const s = store.createSession({ id: crypto.randomUUID(), projectId: project.id, ownerId: me.user.id, ownerName: me.user.name, title, visibility: 'private' });
    store.audit({ userId: me.user.id, projectId: project.id, sessionId: s.id, action: 'session_create', status: 'ok' });
    return reply.code(201).send({ session: publicSession(s, me) });
  });

  app.get<{ Params: { sid: string } }>(`${base}/sessions/:sid`, async (req, reply) => {
    const found = await sessionFor(req, reply, req.params.sid, 'view');
    if (!found) return;
    const active = store.activeRun(found.session.id);
    return {
      session: publicSession(found.session, req.identity!),
      messages: store.listMessages(found.session.id).map(publicMessage),
      runs: store.listRuns(found.session.id),
      activity: store.listSessionActivity(found.session.id),
      proposals: store.listProposals(found.session.id),
      activeRunId: active && runs.isLive(active.id) ? active.id : null,
    };
  });

  app.patch<{ Params: { sid: string } }>(`${base}/sessions/:sid`, async (req, reply) => {
    const found = await sessionFor(req, reply, req.params.sid, 'own');
    if (!found) return;
    const body = PatchBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Send a title (1–120 characters) and/or visibility "private" or "project"' });
    const s = store.updateSession(found.session.id, body.data);
    if (body.data.visibility && body.data.visibility !== found.session.visibility) {
      store.audit({ userId: req.identity!.user.id, projectId: found.project.id, sessionId: found.session.id, action: 'session_visibility', status: 'ok', detail: { from: found.session.visibility, to: body.data.visibility } });
    }
    return { session: publicSession(s!, req.identity!) };
  });

  app.delete<{ Params: { sid: string } }>(`${base}/sessions/:sid`, async (req, reply) => {
    const found = await sessionFor(req, reply, req.params.sid, 'own');
    if (!found) return;
    const active = store.activeRun(found.session.id);
    if (active) runs.cancel(active.id, req.identity!.user.id, found.project.id);
    store.deleteSession(found.session.id);
    store.audit({ userId: req.identity!.user.id, projectId: found.project.id, sessionId: found.session.id, action: 'session_delete', status: 'ok' });
    return reply.code(204).send();
  });

  app.post<{ Params: { sid: string } }>(`${base}/sessions/:sid/messages`, { bodyLimit: MESSAGE_BODY_LIMIT }, async (req, reply) => {
    const found = await sessionFor(req, reply, req.params.sid, 'own');
    if (!found) return;
    const body = SendBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: `Invalid message: ${body.error.issues[0]?.message ?? 'bad request'}` });
    if (body.data.text.length > config.limits.maxMessageChars) return reply.code(413).send({ error: `Messages are limited to ${config.limits.maxMessageChars} characters` });
    if ((body.data.attachments ?? []).filter((a) => a.kind === 'image').length > MAX_IMAGES) return reply.code(413).send({ error: `At most ${MAX_IMAGES} images per message` });
    if ((body.data.attachments ?? []).filter((a) => a.kind === 'pdf').length > MAX_PDFS) return reply.code(413).send({ error: `At most ${MAX_PDFS} PDFs per message` });
    const model = body.data.model ? config.models.find((m) => modelId(m) === body.data.model) : config.defaultModel;
    if (!model) return reply.code(400).send({ error: `Model "${body.data.model}" is not enabled on this server` });
    if (body.data.context.branch && found.project.branches.length && !found.project.branches.includes(body.data.context.branch)) {
      return reply.code(400).send({ error: `Branch "${body.data.context.branch}" does not exist in this project` });
    }
    try {
      const run = await runs.start({ session: found.session, identity: req.identity!, project: found.project, text: body.data.text, ctx: body.data.context, model, attachments: body.data.attachments });
      return reply.code(202).send({ run });
    } catch (err) {
      if (err instanceof BusyError) return reply.code(409).send({ error: err.message });
      req.log.error({ err }, 'run start failed');
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { mid: string; idx: string; sub?: string } }>(`${base}/messages/:mid/blocks/:idx/:sub?`, async (req, reply) => {
    const m = /^\d{1,12}$/.test(req.params.mid) ? store.getMessage(Number(req.params.mid)) : null;
    const b = m?.blocks[Number(req.params.idx)];
    let media: { mediaType: string; data: string } | undefined;
    if (b?.type === 'image' || b?.type === 'document') media = b;
    else if (b?.type === 'tool_result' && req.params.sub !== undefined) media = b.images?.[Number(req.params.sub)];
    if (!m || !media) return reply.code(404).send({ error: 'Attachment not found' });
    const found = await sessionFor(req, reply, m.sessionId, 'view');
    if (!found) return;
    return reply
      .header('content-type', media.mediaType)
      .header('cache-control', 'private, max-age=86400')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(Buffer.from(media.data, 'base64'));
  });

  app.get<{ Params: { rid: string }; Querystring: { after?: string } }>(`${base}/runs/:rid/events`, async (req, reply) => {
    const run = ID_RE.test(req.params.rid) ? store.getRun(req.params.rid) : null;
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    const found = await sessionFor(req, reply, run.sessionId, 'view');
    if (!found) return;
    const after = Number(req.headers['last-event-id'] ?? req.query.after ?? 0) || 0;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    };
    const unsubscribe = runs.subscribe(run.id, after, (e) => {
      res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
    }, close);
    req.raw.on('close', close);
  });

  app.post<{ Params: { rid: string } }>(`${base}/runs/:rid/cancel`, async (req, reply) => {
    const run = ID_RE.test(req.params.rid) ? store.getRun(req.params.rid) : null;
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    const found = await sessionFor(req, reply, run.sessionId, 'own');
    if (!found) return;
    const cancelled = runs.cancel(run.id, req.identity!.user.id, found.project.id);
    return { cancelled };
  });

  async function proposalFor(req: FastifyRequest, reply: FastifyReply, id: string, mode: 'view' | 'own') {
    const p = ID_RE.test(id) ? store.getProposal(id) : null;
    if (!p) { reply.code(404).send({ error: 'Proposal not found' }); return null; }
    const found = await sessionFor(req, reply, p.sessionId, mode);
    if (!found) return null;
    return { proposal: p, ...found };
  }

  app.get<{ Params: { id: string } }>(`${base}/proposals/:id`, async (req, reply) => {
    const found = await proposalFor(req, reply, req.params.id, 'view');
    if (!found) return;
    return { proposal: found.proposal };
  });

  app.post<{ Params: { id: string } }>(`${base}/proposals/:id/accept`, async (req, reply) => {
    const found = await proposalFor(req, reply, req.params.id, 'own');
    if (!found) return;
    const body = AcceptBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: `Invalid edit: ${body.error.issues[0]?.message ?? 'bad request'}` });
    try {
      const identity = req.identity!;
      const onSettled = (p: Proposal) => { runs.continueAfter(p, identity).catch((err) => req.log.warn({ err }, 'continue after review failed')); };
      const proposal = await acceptProposal({ store, aldine, config, onSettled }, { proposal: found.proposal, session: found.session, identity, parts: body.data });
      return { proposal };
    } catch (err) {
      if (err instanceof ProposalError) return reply.code(err.status).send({ error: err.message });
      req.log.error({ err }, 'accept failed');
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>(`${base}/proposals/:id/reject`, async (req, reply) => {
    const found = await proposalFor(req, reply, req.params.id, 'own');
    if (!found) return;
    try {
      const rejected = rejectProposal(store, { proposal: found.proposal, session: found.session, identity: req.identity! });
      await runs.continueAfter(rejected, req.identity!).catch((err) => req.log.warn({ err }, 'continue after review failed'));
      return { proposal: store.getProposal(rejected.id) };
    } catch (err) {
      if (err instanceof ProposalError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  app.get<{ Params: { sid: string } }>(`${base}/sessions/:sid/audit`, async (req, reply) => {
    const found = await sessionFor(req, reply, req.params.sid, 'own');
    if (!found) return;
    return { audit: store.listAudit({ sessionId: found.session.id, limit: 500 }) };
  });

  return app;
}
