import { buildApp } from './app.js';
import { config, dbPath } from './config.js';
import { openDb } from './db.js';
import { hasPassword, setPassword } from './auth.js';
import { refreshArchived } from './lists.js';
import { startScheduler } from './scheduler.js';

openDb(dbPath());
if (!hasPassword() && config.envAdminPassword) setPassword(config.envAdminPassword);
refreshArchived();

const app = await buildApp({ logger: true });
startScheduler((msg, err) => (err ? app.log.error({ err }, msg) : app.log.info(msg)));

await app.listen({ host: '0.0.0.0', port: config.port });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
