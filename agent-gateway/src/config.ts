import path from 'node:path';

export type ProviderKind = 'anthropic' | 'openai' | 'mock';

export interface ProviderConfig {
  /** Stable id used in model refs (`<id>:<model>`), e.g. `anthropic`, `local`, `openrouter`. */
  id: string;
  kind: ProviderKind;
  apiKey?: string;
  baseUrl?: string;
}

export interface ModelRef {
  provider: string;
  model: string;
  /** What the UI shows in the model selector. */
  label: string;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface Limits {
  maxIterations: number;
  runTimeoutMs: number;
  toolTimeoutMs: number;
  maxOutputTokens: number;
  /** Tool results are cut to this many characters before they reach the model. */
  maxToolResultChars: number;
  maxCompilesPerRun: number;
  maxMessageChars: number;
}

export interface Config {
  host: string;
  port: number;
  /** Path prefix the gateway is mounted under, same origin as Aldine. */
  basePath: string;
  aldineUrl: string;
  /** Only for Aldine deployments with AUTH_ENABLED off: the operator-wide MCP token. */
  aldineOperatorToken?: string;
  dataDir: string;
  agentId: string;
  agentLabel: string;
  providers: ProviderConfig[];
  models: ModelRef[];
  defaultModel: ModelRef;
  effort: Effort;
  limits: Limits;
}

const int = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
};

function normBase(p: string | undefined): string {
  const s = (p ?? '/agent-gateway').trim().replace(/\/+$/, '');
  if (!s) return '';
  return s.startsWith('/') ? s : '/' + s;
}

export function parseModelRef(ref: string, providers: ProviderConfig[]): ModelRef {
  const i = ref.indexOf(':');
  if (i <= 0) throw new Error(`Model "${ref}" must be written as <provider>:<model>, e.g. anthropic:claude-haiku-5-5`);
  const provider = ref.slice(0, i);
  const model = ref.slice(i + 1);
  if (!providers.some((p) => p.id === provider)) {
    throw new Error(`Model "${ref}" names provider "${provider}", which is not configured`);
  }
  return { provider, model, label: model };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const providers: ProviderConfig[] = [];
  if (env.ANTHROPIC_API_KEY) {
    providers.push({ id: 'anthropic', kind: 'anthropic', apiKey: env.ANTHROPIC_API_KEY, baseUrl: env.ANTHROPIC_BASE_URL || undefined });
  }
  if (env.OPENAI_API_KEY) {
    providers.push({ id: 'openai', kind: 'openai', apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1' });
  }
  if (env.OPENROUTER_API_KEY) {
    providers.push({ id: 'openrouter', kind: 'openai', apiKey: env.OPENROUTER_API_KEY, baseUrl: 'https://openrouter.ai/api/v1' });
  }
  if (env.LOCAL_LLM_BASE_URL) {
    providers.push({ id: 'local', kind: 'openai', apiKey: env.LOCAL_LLM_API_KEY || undefined, baseUrl: env.LOCAL_LLM_BASE_URL });
  }
  if (env.AGENT_ENABLE_MOCK === '1') providers.push({ id: 'mock', kind: 'mock' });
  if (!providers.length) {
    throw new Error('No model provider configured: set ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, LOCAL_LLM_BASE_URL or AGENT_ENABLE_MOCK=1');
  }

  const defaults: Record<string, string> = {
    anthropic: 'claude-haiku-5-5',
    openai: 'gpt-5-mini',
    openrouter: 'anthropic/claude-haiku-5-5',
    local: env.LOCAL_LLM_MODEL || 'local-model',
    mock: 'scripted',
  };
  const defaultProvider = env.AGENT_DEFAULT_PROVIDER || providers[0].id;
  if (!providers.some((p) => p.id === defaultProvider)) {
    throw new Error(`AGENT_DEFAULT_PROVIDER="${defaultProvider}" is not a configured provider (configured: ${providers.map((p) => p.id).join(', ')})`);
  }
  const defaultModel: ModelRef = {
    provider: defaultProvider,
    model: env.AGENT_DEFAULT_MODEL || defaults[defaultProvider],
    label: env.AGENT_DEFAULT_MODEL || defaults[defaultProvider],
  };

  // AGENT_MODELS is the admin allowlist the UI may offer; the default is always included.
  const models: ModelRef[] = [defaultModel];
  for (const ref of (env.AGENT_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = parseModelRef(ref, providers);
    if (!models.some((x) => x.provider === m.provider && x.model === m.model)) models.push(m);
  }
  if (env.LOCAL_LLM_BASE_URL && env.LOCAL_LLM_MODEL && !models.some((m) => m.provider === 'local')) {
    models.push({ provider: 'local', model: env.LOCAL_LLM_MODEL, label: `${env.LOCAL_LLM_MODEL} (local)` });
  }

  const effort = (env.AGENT_EFFORT || 'medium') as Effort;
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error(`AGENT_EFFORT="${effort}" must be low, medium, high, xhigh or max`);

  return {
    host: env.AGENT_GATEWAY_HOST || '127.0.0.1',
    port: int(env.AGENT_GATEWAY_PORT, 3300),
    basePath: normBase(env.AGENT_GATEWAY_BASE_PATH),
    aldineUrl: (env.ALDINE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    aldineOperatorToken: env.ALDINE_MCP_TOKEN || undefined,
    dataDir: path.resolve(env.AGENT_DATA_DIR || '.data'),
    agentId: env.AGENT_ID || 'paper-assistant-v1',
    agentLabel: env.AGENT_LABEL || 'Paper Assistant',
    providers,
    models,
    defaultModel,
    effort,
    limits: {
      maxIterations: int(env.AGENT_MAX_ITERATIONS, 12),
      runTimeoutMs: int(env.AGENT_RUN_TIMEOUT_MS, 5 * 60_000),
      toolTimeoutMs: int(env.AGENT_TOOL_TIMEOUT_MS, 90_000),
      maxOutputTokens: int(env.AGENT_MAX_OUTPUT_TOKENS, 32_000),
      maxToolResultChars: int(env.AGENT_MAX_TOOL_RESULT_CHARS, 40_000),
      maxCompilesPerRun: int(env.AGENT_MAX_COMPILES_PER_RUN, 3),
      maxMessageChars: int(env.AGENT_MAX_MESSAGE_CHARS, 20_000),
    },
  };
}
