FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY client ./client
COPY shared ./shared
COPY vite.config.js ./
RUN VITE_LAB_CLOUD_TEST=1 npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=8080
# Only dependency-free document/gateway code and synthetic generator enter runtime.
COPY --from=build /app/dist ./dist
COPY server/storage.mjs server/validation.mjs server/postits.mjs server/document-app.mjs server/workspace.mjs server/restore.mjs server/cloud-app.mjs server/cloud-start.mjs server/cloud-ai.mjs server/block-edit.mjs ./server/
COPY scripts/workspace-fixture.mjs scripts/ai-requests.mjs scripts/ai-groups.mjs ./scripts/
COPY shared/block-edit.mjs shared/font-size.mjs shared/postit-contract.mjs shared/ai-goal.mjs ./shared/
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/cloud-start.mjs"]
