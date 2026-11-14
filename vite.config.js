import { defineConfig } from 'vite';

const b1003=process.env.LAB_B10_03_ISOLATED==='1';
const followup=process.env.LAB_B09_FOLLOWUP==='1';
const b09=process.env.LAB_B09_ISOLATED==='1';
const isolated=process.env.LAB_B06_ISOLATED==='1';
export default defineConfig({
  root: 'client',
  plugins: [{name:'cloud-test-marker',transformIndexHtml(html){return process.env.VITE_LAB_CLOUD_TEST==='1'?html.replace('</head>','<meta name="blocknote-cloud-test" content="synthetic-only"></head>'):html;}}],
  server: {
    port: b1003?45173:followup?35173:b09?25173:isolated?15173:5173,
    strictPort: true,
    proxy: { '/api': b1003?'http://127.0.0.1:48787':followup?'http://127.0.0.1:38787':b09?'http://127.0.0.1:28787':isolated?'http://127.0.0.1:18787':'http://127.0.0.1:8787' },
  },
  build: { outDir: '../dist', emptyOutDir: true },
});
