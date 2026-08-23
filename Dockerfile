# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=26-alpine

# ---- 1. install workspace deps (cached on lockfile changes) ----
FROM node:${NODE_VERSION} AS deps
WORKDIR /workspace
RUN corepack enable
COPY pnpm-workspace.yaml package.json ./
COPY packages/bibliograph-service/package.json ./packages/bibliograph-service/
RUN pnpm install --ignore-scripts

# ---- 2. build the service ----
FROM node:${NODE_VERSION} AS build
WORKDIR /workspace
RUN corepack enable
COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=deps /workspace/packages/bibliograph-service/node_modules ./packages/bibliograph-service/node_modules
COPY pnpm-workspace.yaml package.json ./
COPY packages ./packages
RUN pnpm --filter bibliograph-service build

# ---- 3. minimal runtime ----
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build --chown=1000:1000 /workspace/packages ./packages
COPY --from=build --chown=1000:1000 /workspace/pnpm-workspace.yaml ./
COPY --from=build --chown=1000:1000 /workspace/package.json ./
RUN pnpm install --prod --ignore-scripts
# Run as the same UID Dokku's herokuish uses (1000). This matches the host-side
# `/srv/data/bibliograph/data/lex` files published by the build script.
USER 1000
EXPOSE 5000
CMD ["node", "packages/bibliograph-service/build/index.js"]
