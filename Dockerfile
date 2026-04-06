FROM node:22-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

FROM base AS deps
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg supervisor \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY worker/package.json ./worker/package.json
COPY packages/shared/package.json ./packages/shared/package.json

RUN pnpm install --frozen-lockfile

FROM deps AS builder
WORKDIR /app

COPY . .
RUN pnpm build

FROM base AS runner
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg supervisor \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV SQLITE_DB_PATH=/data/deal-pump.sqlite
ENV ARTIFACTS_DIR=/data/artifacts
ENV WORKER_CONCURRENCY=1
ENV REQUIRE_FFMPEG=true
ENV PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/worker ./worker
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/supervisord.conf ./supervisord.conf

RUN mkdir -p /data/artifacts

EXPOSE 3000
CMD ["supervisord", "-c", "/app/supervisord.conf"]
