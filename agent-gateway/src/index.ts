import { HttpAldine } from './aldine/http.ts';
import { loadConfig } from './config.ts';
import { buildProviders } from './providers/index.ts';
import { RunManager } from './runs.ts';
import { buildApp } from './server.ts';
import { SqliteStore } from './store/sqlite.ts';

const config = loadConfig();
const store = new SqliteStore(config.dataDir);
const orphaned = store.failOrphanedRuns();
const aldine = new HttpAldine({ baseUrl: config.aldineUrl, agentLabel: config.agentLabel, operatorToken: config.aldineOperatorToken });
const runs = new RunManager({ store, aldine, providers: buildProviders(config), config });
const app = await buildApp({ config, store, aldine, runs });

app.log.info({
  aldine: config.aldineUrl,
  basePath: config.basePath || '/',
  providers: config.providers.map((p) => p.id),
  defaultModel: `${config.defaultModel.provider}:${config.defaultModel.model}`,
  orphanedRuns: orphaned,
}, 'agent gateway starting');

await app.listen({ host: config.host, port: config.port });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, async () => {
    runs.shutdown();
    await app.close().catch(() => {});
    store.close();
    process.exit(0);
  });
}
