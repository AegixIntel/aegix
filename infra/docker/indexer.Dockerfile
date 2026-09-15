FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @aegix/network build
RUN pnpm --filter @aegix/network deploy --prod /prod/network

FROM node:22-alpine
ENV NODE_ENV=production
RUN addgroup -S aegix && adduser -S -G aegix aegix
WORKDIR /app
COPY --from=build --chown=aegix:aegix /prod/network ./
USER aegix
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/cli.js", "--follow"]
