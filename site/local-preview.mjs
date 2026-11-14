import { Miniflare } from 'miniflare';
import { resolve } from 'node:path';

const preview = new Miniflare({
  modules: true,
  modulesRoot: process.cwd(),
  modulesRules: [{ type: 'ESModule', include: ['**/*.js', '**/*.mjs'] }],
  scriptPath: resolve('site/preview-worker.mjs'),
  compatibilityDate: '2026-05-15',
  compatibilityFlags: ['nodejs_compat'],
  assets: {
    directory: resolve('dist/client'),
    binding: 'ASSETS',
    routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
  },
  r2Buckets: ['BUCKET'],
  cf: false,
  host: '127.0.0.1',
  port: Number(process.env.PORT || 4173),
});

console.log('BlockNote Site preview: ' + await preview.ready);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
  await preview.dispose();
  process.exit(0);
});
