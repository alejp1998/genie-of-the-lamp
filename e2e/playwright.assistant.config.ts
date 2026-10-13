import { defineConfig } from '@playwright/test';

/** Aladine assistant suite: Aldine with auth + MCP on :3260, the Agent Gateway
 *  on :3261 with the scripted mock model (no provider key, no cost), and a
 *  same-origin front proxy on :3262 that the browser talks to. No compiler:
 *  the typeset after an accept reports a failure, which the tests accept.
 *  A local stand-in for OpenAlex, arXiv, SearXNG and doi.org answers the
 *  research tools on :3263. Ports: E2E_ASSIST_PORT (+1, +2, +3). */
const PORT = Number(process.env.E2E_ASSIST_PORT || 3260);
const GW = PORT + 1;
const FRONT = PORT + 2;
const MOCK = `http://127.0.0.1:${PORT + 3}`;

export default defineConfig({
  testDir: './assistant-tests',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 1,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${FRONT}`, trace: 'retain-on-failure', viewport: { width: 1600, height: 960 } },
  webServer: [
    {
      command: `RESEARCH_MOCK_PORT=${PORT + 3} node assistant-tests/research-mock.mjs`,
      port: PORT + 3,
      reuseExistingServer: true,
      timeout: 10_000,
    },
    {
      command: `npm run build -w apps/web && HOST=127.0.0.1 PORT=${PORT} AUTH_ENABLED=1 ALDINE_MCP=1 RL_REGISTER_BURST=500 RL_LOGIN_BURST=500 RL_MCP_BURST=5000 ALDINE_AGENT_PRESENCE_TTL_MS=3000 DOI_API_BASE=${MOCK}/doi COMPILER_URL=http://127.0.0.1:9 DATA_DIR=$(pwd)/.data-assistant META_DIR=$(pwd)/.secrets-assistant npx tsx apps/server/src/index.ts`,
      cwd: '..',
      port: PORT,
      reuseExistingServer: true,
      timeout: 600_000,
    },
    {
      command: `AGENT_ENABLE_MOCK=1 AGENT_DEFAULT_PROVIDER=mock OPENALEX_BASE_URL=${MOCK}/openalex ARXIV_BASE_URL=${MOCK}/arxiv SEARXNG_URL=${MOCK}/searxng AGENT_RESEARCH_ALLOW_PRIVATE=1 ALDINE_URL=http://127.0.0.1:${PORT} AGENT_GATEWAY_HOST=127.0.0.1 AGENT_GATEWAY_PORT=${GW} AGENT_DATA_DIR=$(pwd)/../.data-assistant-gw LOG_LEVEL=warn npm start`,
      cwd: '../agent-gateway',
      port: GW,
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: `PROXY_PORT=${FRONT} ALDINE_URL=http://127.0.0.1:${PORT} GATEWAY_URL=http://127.0.0.1:${GW} node assistant-tests/front-proxy.mjs`,
      port: FRONT,
      reuseExistingServer: true,
      timeout: 10_000,
    },
  ],
});
