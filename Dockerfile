# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: install workspace deps, build web UI + bundled server
# ---------------------------------------------------------------------------
FROM node:24-trixie-slim AS build
WORKDIR /src

# Toolchain in case better-sqlite3 has no prebuilt binary for this platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Manifests first for better layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm build

# Native runtime deps only (everything else is bundled into dist/index.js).
RUN mkdir /runtime \
 && cd /runtime \
 && BSQ=$(node -p "require('/src/apps/server/node_modules/better-sqlite3/package.json').version") \
 && npm init -y >/dev/null \
 && npm install --omit=dev --no-audit --no-fund "better-sqlite3@${BSQ}"

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM node:24-trixie-slim AS runtime

ARG MUNY_VERSION=dev
LABEL org.opencontainers.image.title="Muny" \
      org.opencontainers.image.description="Self-hosted personal finance and subscription manager" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${MUNY_VERSION}"

ENV NODE_ENV=production \
    MUNY_HOST=0.0.0.0 \
    MUNY_PORT=8420 \
    MUNY_DATA_DIR=/data \
    MUNY_WEB_DIR=/app/web \
    MUNY_MIGRATIONS_DIR=/app/migrations

WORKDIR /app
COPY --from=build /runtime/node_modules ./node_modules
COPY --from=build /src/apps/server/dist ./
COPY --from=build /src/apps/web/dist ./web
COPY --from=build /src/packages/db/migrations ./migrations
COPY LICENSE ./

# Runs as the unprivileged "node" user (uid 1000) by default. On Synology,
# override with `user: "<uid>:<gid>"` matching the owner of the data folder.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8420

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.MUNY_PORT||8420)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "--enable-source-maps", "index.js"]
