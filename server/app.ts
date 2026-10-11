import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAddonRoutes } from './addon.js';
import { registerApiRoutes } from './api.js';

export async function buildApp(opts: { logger?: boolean; webDir?: string } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true });
  await app.register(cookie);

  app.get('/health', async () => ({ ok: true }));
  registerApiRoutes(app);
  registerAddonRoutes(app);

  const webDir = opts.webDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
  if (fs.existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir });
  }
  return app;
}
