# AEGIX Web (Next.js) image — multi-stage build.
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/blockchain/package.json packages/blockchain/package.json
COPY packages/cache/package.json packages/cache/package.json
COPY packages/commonality/package.json packages/commonality/package.json
COPY packages/types/package.json packages/types/package.json
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
COPY packages/webhook-delivery/package.json packages/webhook-delivery/package.json
COPY packages/ai/package.json packages/ai/package.json
COPY packages/billing/package.json packages/billing/package.json
COPY packages/context/package.json packages/context/package.json
COPY packages/markets/package.json packages/markets/package.json
COPY packages/network/package.json packages/network/package.json
RUN pnpm install --frozen-lockfile --prod=false

FROM deps AS build
ARG NEXT_PUBLIC_API_URL=/api
ARG API_INTERNAL_URL=http://api:3001
ARG NEXT_PUBLIC_SITE_URL=https://aegixintelligence.com
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV API_INTERNAL_URL=$API_INTERNAL_URL
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
COPY tsconfig.base.json ./
COPY packages/types packages/types
COPY packages/config packages/config
COPY packages/markets packages/markets
COPY apps/web apps/web
RUN pnpm --filter @aegix/web... build

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=build /app/apps/web/public apps/web/public
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/static apps/web/.next/static

USER nextjs
WORKDIR /app/apps/web
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
