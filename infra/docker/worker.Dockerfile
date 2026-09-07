# AEGIX worker image — build all workspace packages then run the worker.
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/blockchain/package.json packages/blockchain/package.json
COPY packages/normalizer/package.json packages/normalizer/package.json
COPY packages/intelligence/package.json packages/intelligence/package.json
COPY packages/scoring/package.json packages/scoring/package.json
COPY packages/graph/package.json packages/graph/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY packages/cache/package.json packages/cache/package.json
COPY packages/commonality/package.json packages/commonality/package.json
COPY packages/correlation/package.json packages/correlation/package.json
COPY packages/diff/package.json packages/diff/package.json
COPY packages/explanation/package.json packages/explanation/package.json
COPY packages/logging/package.json packages/logging/package.json
COPY packages/monitor/package.json packages/monitor/package.json
COPY packages/webhook-delivery/package.json packages/webhook-delivery/package.json
RUN pnpm install --frozen-lockfile --prod=false

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm --filter "./packages/**" --filter "./apps/**" build
RUN pnpm --filter @aegix/worker deploy --prod /prod/worker && \
    rm -rf /prod/worker/src /prod/worker/tsconfig.json && \
    find /prod/worker/node_modules/@aegix -type d -name src -prune -exec rm -rf {} + && \
    find /prod/worker -type f -name '*.test.*' -delete

FROM base AS runtime
ENV NODE_ENV=production
RUN addgroup -S aegix && adduser -S -G aegix aegix
COPY --from=build --chown=aegix:aegix /prod/worker /app
USER aegix
WORKDIR /app
CMD ["node", "dist/index.js"]
