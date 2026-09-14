# Dedicated production migration image. It runs compiled JavaScript and never
# depends on tsx or a development NODE_ENV.
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/blockchain/package.json packages/blockchain/package.json
COPY packages/cache/package.json packages/cache/package.json
COPY packages/commonality/package.json packages/commonality/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/correlation/package.json packages/correlation/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/diff/package.json packages/diff/package.json
COPY packages/explanation/package.json packages/explanation/package.json
COPY packages/graph/package.json packages/graph/package.json
COPY packages/intelligence/package.json packages/intelligence/package.json
COPY packages/logging/package.json packages/logging/package.json
COPY packages/monitor/package.json packages/monitor/package.json
COPY packages/normalizer/package.json packages/normalizer/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY packages/scoring/package.json packages/scoring/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/webhook-delivery/package.json packages/webhook-delivery/package.json
COPY packages/ai/package.json packages/ai/package.json
COPY packages/billing/package.json packages/billing/package.json
COPY packages/context/package.json packages/context/package.json
COPY packages/markets/package.json packages/markets/package.json
RUN pnpm install --frozen-lockfile --prod=false

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/config packages/config
COPY packages/types packages/types
COPY packages/database packages/database
RUN pnpm --filter @aegix/database... build
RUN pnpm --filter @aegix/database deploy --prod /prod/database && \
    rm -rf /prod/database/src /prod/database/tsconfig.json && \
    find /prod/database/node_modules/@aegix -type d -name src -prune -exec rm -rf {} + && \
    find /prod/database -type f -name '*.test.*' -delete

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
RUN addgroup -S aegix && adduser -S -G aegix aegix
WORKDIR /app
COPY --from=build --chown=aegix:aegix /prod/database /app
USER aegix
CMD ["node", "dist/migrate.js"]
