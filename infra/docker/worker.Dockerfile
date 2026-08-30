# AEGIX worker image — build all workspace packages then run the worker.
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
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
RUN pnpm install --frozen-lockfile --prod=false

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm --filter "./packages/**" --filter "./apps/**" build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages packages
COPY --from=build /app/apps/worker/dist apps/worker/dist
WORKDIR /app/apps/worker
CMD ["node", "dist/index.js"]
