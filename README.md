# ad-video-agent (Task 1 bootstrap)

This repository is the **Task 1 platform bootstrap** for a single-service generative pipeline. It keeps the Next.js app at the root and adds a worker + shared TypeScript layer for the SQLite-backed run engine foundation.

## Prerequisites

- Node.js **22.x**
- pnpm **10.x**
- Python **3.x** (required by `pnpm run-engine:check` for local SQLite pragma/version probing via stdlib `sqlite3`)
- Playwright browsers (for E2E):
  - `pnpm exec playwright install`
- Local media tooling for non-container runs:
  - `ffmpeg`
  - `ffprobe`

## Architecture assumptions (locked)

- One Railway-style container/service runs both:
  - Next.js web server
  - background worker
- Persistent volume is mounted at `/data`.
- SQLite path in deployment is `/data/deal-pump.sqlite`.
- Artifacts directory in deployment is `/data/artifacts`.
- Worker concurrency is locked to `1` for SQLite safety.

## Project layout

- `app/` — Next.js App Router UI shell
- `worker/` — worker bootstrap process
- `packages/shared/` — shared bootstrap contracts/helpers
- `scripts/` — startup and run-engine checks
- `tests/` — unit, integration, security, and e2e baseline suites

## Environment

Copy `.env.example` to `.env.local` (or `.env`) and adjust values for local development.

In production, enforce:

```bash
DATA_DIR=/data
SQLITE_DB_PATH=/data/deal-pump.sqlite
ARTIFACTS_DIR=/data/artifacts
WORKER_CONCURRENCY=1
REQUIRE_FFMPEG=true
```

## Commands

- `pnpm dev` — start Next.js with bootstrap env validation
- `pnpm worker:dev` — run worker in watch mode
- `pnpm dev:full` — run web + worker together
- `pnpm worker:start` — start worker once
- `pnpm run-engine:check` — verify SQLite path intent, writable storage, artifacts dir, PRAGMAs, and ffmpeg guard behavior (requires `python3`)
- `pnpm test:unit`
- `pnpm test:integration`
- `pnpm test:security`
- `pnpm test:e2e`
- `pnpm verify` — lint + typecheck + unit + integration + security + build

## Docker deployment

`Dockerfile` + `supervisord.conf` implement a single-container deployment that runs both web and worker processes. Mount a persistent volume to `/data` in the target platform.
