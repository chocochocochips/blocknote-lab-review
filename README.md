# BlockNote Lab — Library Site review snapshot

Source: Library Site release 28, deployed source commit `0ed9025942c2ae3e2d70aa5b2699fcd485fe2469`. Snapshot date: 2026-11-14 (KST).

The snapshot contains the editor, Site Worker, MCP implementation, provider adapters, and automated tests with synthetic fixtures. The hosting manifest retains its binding declarations with the deployment identity removed. A local dependency link from the source tree was excluded. Use Node.js 22 or newer.

```sh
npm ci
npm test
npm run build
npm run dev
```

The tests run with synthetic data and mocked provider calls. For code review, start with `site/worker.mjs`, `site/ai-providers.mjs`, `site/mcp.mjs`, and `client/src/AiPanel.jsx`. Leave provider and publication credentials unset when reviewing locally. The GitHub publication adapter names the project's public document repository.
