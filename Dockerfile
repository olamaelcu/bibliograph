# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=26-alpine

# ---- 1. install workspace deps (cached on lockfile changes) ----
FROM node:${NODE_VERSION} AS deps
WORKDIR /workspace
# Node 26-alpine ships corepack disabled by default; install pnpm directly.
RUN npm install -g pnpm@11.13.1
COPY pnpm-workspace.yaml package.json ./
COPY packages/bibliograph-service/package.json ./packages/bibliograph-service/
RUN pnpm install --ignore-scripts

# ---- 2. build the service ----
FROM node:${NODE_VERSION} AS build
WORKDIR /workspace
RUN npm install -g pnpm@11.13.1
COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=deps /workspace/packages/bibliograph-service/node_modules ./packages/bibliograph-service/node_modules
COPY pnpm-workspace.yaml package.json ./
COPY packages ./packages
RUN pnpm --filter bibliograph-service build

# ---- 3. minimal runtime ----
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN npm install -g pnpm@11.13.1
COPY --from=build --chown=1000:1000 /workspace/packages ./packages
COPY --from=build --chown=1000:1000 /workspace/pnpm-workspace.yaml ./
COPY --from=build --chown=1000:1000 /workspace/package.json ./
RUN pnpm install --prod --ignore-scripts
# Run as the same UID Dokku's herokuish uses (1000). This matches the host-side
# `/srv/data/bibliograph/data/lex` files published by the build script.
USER 1000
EXPOSE 5000
# Entrypoint runs the migrator (idempotent — see src/lib/server/db/migrate.ts)
# before exec'ing the web process. Dokku's dockerfile builder ignores Procfile
# `release:` entries, so the Dockerfile is the only hook point. The migrator
# fails closed on any non-duplicate PG error, which crashes the container and
# surfaces a clear deploy failure instead of starting the app against a stale
# schema.
ENTRYPOINT ["sh", "-c", "node_modules/.bin/tsx packages/bibliograph-service/src/lib/server/db/migrate.ts && exec node packages/bibliograph-service/build/index.js"]