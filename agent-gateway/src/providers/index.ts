import type { Config } from '../config.ts';
import { AnthropicProvider } from './anthropic.ts';
import { MockProvider } from './mock.ts';
import { OpenAICompatibleProvider } from './openai.ts';
import type { Provider } from './types.ts';

export function buildProviders(config: Config): Map<string, Provider> {
  const out = new Map<string, Provider>();
  for (const p of config.providers) {
    if (p.kind === 'anthropic') out.set(p.id, new AnthropicProvider(p.id, p.apiKey!, p.baseUrl));
    else if (p.kind === 'openai') out.set(p.id, new OpenAICompatibleProvider(p.id, p.baseUrl!, p.apiKey, !!p.vision));
    else out.set(p.id, new MockProvider(p.id));
  }
  return out;
}
