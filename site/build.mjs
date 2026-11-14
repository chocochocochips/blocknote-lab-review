import { resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build as buildClient } from 'vite';
import { build as bundleWorker } from 'esbuild';

process.env.VITE_LAB_SITE = '1';
await buildClient({ build: { outDir: '../dist/client', emptyOutDir: true } });
await bundleWorker({
  entryPoints: ['site/worker.mjs'],
  outfile: 'dist/server/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  plugins: [{
    name: 'workspace-vfs',
    setup(builder) {
      const adapter = resolve('site/worker-fs.mjs');
      builder.onResolve({ filter: /^node:fs$/ }, args => args.importer === adapter
        ? { path: args.path, external: true }
        : { path: adapter });
    },
  }],
});
mkdirSync('dist/.openai', { recursive: true });
writeFileSync('dist/.openai/hosting.json', readFileSync('.openai/hosting.json'));
writeFileSync('dist/server/wrangler.json', JSON.stringify({
  name: 'blocknote-lab-b10-03',
  main: 'index.js',
  compatibility_date: '2026-05-15',
  compatibility_flags: ['nodejs_compat'],
  assets: { directory: '../client', binding: 'ASSETS', run_worker_first: true },
  r2_buckets: [{ binding: 'BUCKET', bucket_name: 'blocknote-site-local' }],
}, null, 2));
