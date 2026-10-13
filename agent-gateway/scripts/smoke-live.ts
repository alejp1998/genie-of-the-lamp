/**
 * Live smoke test: real model + real Aldine (AUTH_ENABLED=1, ALDINE_MCP=1).
 * Spends a few cents of provider credit. Usage:
 *   node --env-file=.env scripts/smoke-live.ts [provider:model] ["question"]
 */
import crypto from 'node:crypto';
import { newRunState, READ_TOOLS } from '../src/agent/tools.ts';
import { runLoop } from '../src/agent/loop.ts';
import { systemPrompt } from '../src/agent/prompt.ts';
import { buildContextBlock } from '../src/agent/context.ts';
import { HttpAldine } from '../src/aldine/http.ts';
import { loadConfig, parseModelRef } from '../src/config.ts';
import { buildProviders } from '../src/providers/index.ts';
import type { ChatMessage } from '../src/providers/types.ts';

const config = loadConfig();
const ref = process.argv[2] ? parseModelRef(process.argv[2], config.providers) : config.defaultModel;
const question = process.argv[3] ?? 'Why does this document fail to compile, and what is the smallest fix? Also tell me which sections exist.';
const ALDINE = config.aldineUrl;

const email = `smoke-${crypto.randomBytes(3).toString('hex')}@it.example`;
const reg = await fetch(`${ALDINE}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery-9', name: 'Smoke Tester' }) });
const cookie = /aldine_session=[^;]+/.exec(reg.headers.get('set-cookie') ?? '')?.[0] ?? '';
const proj = await (await fetch(`${ALDINE}/api/projects`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ name: 'Smoke paper', files: {
    'main.tex': '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n\\input{sections/intro}\n\\input{sections/method}\n\\end{document}\n',
    'sections/intro.tex': '\\section{Introduction}\\label{sec:intro}\nSwarm robotics studies many simple robots that coordinate locally.\nSee Section~\\ref{sec:method}.\n',
    'sections/method.tex': '\\section{Method}\\label{sec:method}\nEach robot runs \\textbf{the same controller}. The update is\n\\begin{equation}\n  x_{t+1} = x_t + \\alpha \\nabla f(x_t\n\\end{equation}\n',
  } }),
})).json() as any;

const aldine = new HttpAldine({ baseUrl: ALDINE, agentLabel: config.agentLabel });
const identity = (await aldine.whoami(cookie))!;
const project = (await aldine.project(identity, proj.id))!;
const token = await aldine.credential(identity, project.id);
const provider = buildProviders(config).get(ref.provider)!;
const controller = new AbortController();
const ctxBlock = await buildContextBlock({ aldine, token, project, ctx: { branch: 'main', openFile: 'sections/method.tex', cursor: { line: 4 } }, signal: controller.signal });
const history: ChatMessage[] = [{ role: 'user', blocks: [{ type: 'text', text: ctxBlock, meta: 'context' }, { type: 'text', text: question }] }];

console.log(`\n== ${ref.provider}:${ref.model} · project ${project.id}\n> ${question}\n`);
const t0 = Date.now();
const result = await runLoop({
  provider, model: ref.model, effort: ref.provider === 'anthropic' ? config.effort : undefined,
  system: systemPrompt(config.agentLabel), tools: READ_TOOLS,
  toolCtx: { aldine, token, projectId: project.id, branch: 'main', signal: controller.signal, limits: config.limits, state: newRunState() },
  limits: config.limits, history, persist: () => {},
  emit: (type, data: any) => {
    if (type === 'text') process.stdout.write(data.delta);
    else if (type === 'tool_start') process.stdout.write(`\n  · ${data.activity}`);
    else if (type === 'tool_end') process.stdout.write(` → ${data.summary}\n`);
    else if (type === 'notice') process.stdout.write(`\n  ! ${data.message}\n`);
  },
  audit: () => {}, signal: controller.signal,
});
console.log(`\n\n== ${result.status} in ${((Date.now() - t0) / 1000).toFixed(1)} s · usage ${JSON.stringify(result.usage)}`);
