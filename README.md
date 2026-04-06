# ad-video-agent

`ad-video-agent` is the final submission package for the Deal Pump generative-first creative pipeline. It ships as one public Next.js service with one co-located worker, one persistent `/data` volume, and one SQLite database at `/data/deal-pump.sqlite`. This submission favors stronger engineering signal over strict 6-hour minimization, so the package includes durable orchestration, signed artifact delivery, provenance capture, and reviewer-safe fixture mode.

## What was built

- Public demo UI at `/` for brief submission, status polling, result playback, and provenance review.
- Single-node SQLite run engine with phases `submitted -> normalizing -> policy_validating -> generating_images -> generating_video -> exporting -> completed|failed`.
- Approved-asset policy enforcement and deterministic reviewer flow.
- Signed application routes for final MP4 and provenance delivery, backed by files stored under `/data/artifacts/runs/{runId}/`.
- Container packaging for one Railway-style service that runs both the web app and the worker via `supervisord`.

## How I structured the work

I structured the implementation to de-risk the pipeline in layers: first the shared contracts and approved-asset rules, then the SQLite run engine and worker leasing model, then the AI stage boundaries, then export and provenance, then the API surface, then the public UI, and finally deployment hardening. That sequencing let each layer stabilize before the next one depended on it.

I also treated fixture mode as the primary reviewer path from early on. The goal was to keep the exact same run engine, API contract, UI states, and export flow that production uses, while removing live-provider credentials and uptime as review blockers. The main tradeoff is that the submission shows stronger systems engineering signal than a minimal 6-hour shortcut, but it stays reviewer-friendly because the happy path is deterministic and publicly deployable.

## Architecture

### Deployment shape

- One Railway-style container or service only.
- One persistent volume mounted at `/data`.
- One SQLite file at `/data/deal-pump.sqlite`.
- One worker process only, `WORKER_CONCURRENCY=1`.
- One public URL target only. The same base URL serves the demo UI at `/`, the API at `/api/v1/runs`, and signed artifact routes under `/api/v1/runs/{runId}/artifacts/{artifactName}`.

### Runtime components

- `app/` contains the public Next.js App Router UI and server routes.
- `worker/` runs the background loop that claims queued jobs from SQLite and advances the run state machine.
- `packages/shared/` holds the run engine, schema contracts, policy logic, prompt registry, export pipeline, and env validation.
- `Dockerfile` and `supervisord.conf` package the app and worker into one deployable container.

### Persistence and storage

- SQLite is the single durable state store.
- Production path is locked to `/data/deal-pump.sqlite`.
- Artifact root is `/data/artifacts`.
- Per-run artifacts are written to `/data/artifacts/runs/{runId}/`.
- Current export outputs are `final.mp4` and `provenance.json`.
- Artifact links are never raw filesystem paths. They are signed application routes with a 24 hour TTL.

## Pipeline flow

1. The user submits a brief from the public demo page.
2. `POST /api/v1/runs` checks `Idempotency-Key`, applies start-rate limiting, and creates or reuses a SQLite-backed run.
3. The worker claims the next queued job, renews its lease, and advances the run through the fixed stage order.
4. The run status route serializes the normalized brief, selected asset IDs, current phase, and signed result URLs for the UI.
5. The export stage writes subtitle-burned output plus provenance into `/data/artifacts/runs/{runId}/`.
6. Reviewers watch the final MP4 and inspect provenance through signed API routes served from the same public base URL.

## AI tools and models

The package is architected around these AI tools and prompt contracts:

- OpenAI Responses API with GPT-5.4 mini for script normalization.
- Pre-generated local scene assets stored under `public/assets/approved/` for still selection.
- Vertex AI Veo 3.1 Lite for image-to-video scene animation.
- `ffmpeg` and `ffprobe` for export assembly, subtitle burn-in, and media probing.

The runtime supports both deterministic fixture mode and live provider mode. Fixture mode remains the default reviewer-safe path, while live mode wires real OpenAI Responses API + predefined local scene assets + Vertex AI Veo adapters behind explicit server-only environment configuration.

## How AI accelerated the work

AI helped speed up the structured parts of the system, especially brief normalization design, prompt drafting, schema pressure-testing, and stage-level interface shaping. The hardening work still centered on deterministic contracts, SQLite durability rules, export verification, signed-route delivery, and reviewer-safe fallback behavior.

## Local setup

### Prerequisites

- Node.js `22.x`
- pnpm `10.x`
- Python `3.x`, required by `pnpm run-engine:check`
- `ffmpeg` and `ffprobe` for local non-container export checks
- Playwright browsers for E2E, install with `pnpm exec playwright install`

### Install

```bash
pnpm install
cp .env.example .env.local
```

### Required environment variables

All runtime variables in this project are server-only. Do not expose them as `NEXT_PUBLIC_*` values.

| Variable | Required | Server-only | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | yes | yes | Use `development` locally, `production` in deployment. |
| `DATA_DIR` | yes | yes | Local example can point at `./.data`. Production must be `/data`. |
| `SQLITE_DB_PATH` | yes | yes | Absolute path. Production must be `/data/deal-pump.sqlite`. |
| `ARTIFACTS_DIR` | yes | yes | Absolute path. Production must be `/data/artifacts`. |
| `WORKER_CONCURRENCY` | yes | yes | Must stay `1`. Any other value fails validation. |
| `REQUIRE_FFMPEG` | yes | yes | `false` is acceptable locally, `true` in production. |
| `ARTIFACT_ROUTE_SIGNING_SECRET` | required in deployment, recommended locally | yes | Used to sign final MP4 and provenance routes. Set a strong random secret in any public deployment. |
| `AI_PROVIDER_MODE` | yes | yes | `fixture` (default deterministic path) or `live` (real provider path). |
| `OPENAI_API_KEY` | required when `AI_PROVIDER_MODE=live` | yes | Server-side OpenAI key for Responses API calls in normalize stage. |
| `VERTEX_PROJECT` | required when `AI_PROVIDER_MODE=live` | yes | GCP project ID for Vertex AI Gemini/Veo calls. |
| `VERTEX_LOCATION` | required when `AI_PROVIDER_MODE=live` | yes | Vertex region (for example `us-central1`). |
| `VERTEX_API_VERSION` | optional | yes | Vertex API version for `@google/genai` (defaults to `v1`). |
| `GOOGLE_APPLICATION_CREDENTIALS` | optional | yes | Absolute path to a service-account JSON key file. If omitted, runtime uses ADC. |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | optional | yes | Inline service-account JSON. Useful on Railway; startup writes it to `/tmp` and sets `GOOGLE_APPLICATION_CREDENTIALS`. |
| `PORT` | optional | yes | Used by the web process. Defaults to platform behavior, `3000` inside the container. |

There are currently no required client-side environment variables.

### Commands

```bash
pnpm dev
```

Starts the Next.js app with bootstrap env validation.

```bash
pnpm worker:dev
```

Starts the worker loop in watch mode.

```bash
pnpm dev:full
```

Starts web and worker together for local reviewer testing.

```bash
pnpm worker:start
```

Starts the worker once, useful for supervised or containerized runs.

```bash
pnpm run-engine:check
```

Checks writable storage, SQLite path intent, SQLite PRAGMAs, SQLite version expectations, and `ffmpeg` prerequisites.

```bash
pnpm verify
```

Runs the locked verification bundle:

```bash
pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration && pnpm test:security && pnpm build
```

Optional additional check:

```bash
pnpm test:e2e
```

## Reviewer-safe fixture mode, default path

Fixture mode is the safest review path and is the default state in the public UI.

1. Run `pnpm install`.
2. Copy `.env.example` to `.env.local`.
3. Run `pnpm dev:full`.
4. Open `http://localhost:3000/`.
5. Leave the Fixture Mode toggle enabled.
6. Click the sample brief button, then click Generate.
7. Wait for the run to complete, then review the normalized JSON, selected approved assets, final video, and provenance panel.

This path exercises the same public routes, the same SQLite-backed run engine, the same UI states, and the same export route shape without making the reviewer depend on live provider access.

## Live provider mode (OpenAI + Vertex AI)

Set `AI_PROVIDER_MODE=live` and provide the server-only provider credentials/configuration:

```bash
AI_PROVIDER_MODE=live
OPENAI_API_KEY=replace-with-openai-key
VERTEX_PROJECT=your-gcp-project-id
VERTEX_LOCATION=us-central1
VERTEX_API_VERSION=v1
```

If you are not using ADC from attached runtime identity, set:

```bash
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
```

The `fixtureMode` request field remains supported. In live runtime mode, runs with `fixtureMode: true` continue to use deterministic fixture providers.

## Deployment

### Target shape

Deploy this package as one Railway-style containerized service. Do not split the worker into a second service. Do not target Vercel for the full deployment.

### Container behavior

- `Dockerfile` installs `ffmpeg` and `supervisor`.
- `supervisord.conf` runs:
  - `pnpm start` for the web server
  - `pnpm worker:start` for the worker
- The container exposes port `3000`.
- The deployment must mount a persistent volume at `/data`.

### Production env contract

```bash
NODE_ENV=production
DATA_DIR=/data
SQLITE_DB_PATH=/data/deal-pump.sqlite
ARTIFACTS_DIR=/data/artifacts
WORKER_CONCURRENCY=1
REQUIRE_FFMPEG=true
ARTIFACT_ROUTE_SIGNING_SECRET=replace-with-a-strong-random-secret
AI_PROVIDER_MODE=live
OPENAI_API_KEY=replace-with-openai-key
VERTEX_PROJECT=your-gcp-project-id
VERTEX_LOCATION=us-central1
VERTEX_API_VERSION=v1
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
PORT=3000
```

### Public URL target

Expose one public base URL for the service, for example `https://your-service.example`. Reviewers only need that one URL. The UI, API, and signed artifact endpoints all live under the same base URL.

## Security posture

- No auth is implemented. This is an intentional public demo submission.
- Secrets are server-only. No required `NEXT_PUBLIC_*` values are used.
- Start and status routes have in-memory IP-based rate limiting.
  - Start: 5 requests per 10 minutes per IP.
  - Status: 60 requests per minute per IP.
- Artifact delivery uses signed application routes, not public filesystem exposure.
- Signed artifact links expire after 24 hours.
- Secret redaction helpers mask secret-like env values in logs and diagnostics.
- Fixture mode is the safest public reviewer path because it avoids dependence on live provider credentials and provider uptime.

## SQLite single-node tradeoffs

SQLite is the right fit here for a single-service demo with one worker and a persistent disk. It keeps the submission simple to deploy, durable enough for reviewer traffic, and easy to inspect. The tradeoff is that horizontal write scaling is intentionally off the table, which is why the docs and runtime checks lock `WORKER_CONCURRENCY=1` and require a single node with a local persistent volume.

## Artifact retention and storage layout

- Run artifacts accumulate on the mounted volume until they are manually removed.
- There is no background retention sweeper in this submission.
- Each run gets its own directory under `/data/artifacts/runs/{runId}/`.
- Review output is served through signed routes only.
- Provenance captures source asset IDs, prompt metadata, provider job references when present, signed artifact metadata, and export metadata.

## Startup and runtime failure modes

Expect fast failure in these cases:

- `WORKER_CONCURRENCY` is not exactly `1`.
- `SQLITE_DB_PATH` or `ARTIFACTS_DIR` is not absolute.
- Production `SQLITE_DB_PATH` is not `/data/deal-pump.sqlite`.
- Production `ARTIFACTS_DIR` is not `/data/artifacts`.
- `/data` or the artifact directory is not writable.
- `ffmpeg` or `ffprobe` is missing while `REQUIRE_FFMPEG=true`.
- SQLite probing fails or the runtime guard PRAGMAs cannot be applied.
- Signed artifact routes will return `403` for invalid signatures and `410` for expired links.

Use `pnpm run-engine:check` before deployment and as part of runtime debugging.

## Future improvements

- Move rate limiting from in-memory state to a process-safe shared mechanism if the service ever grows beyond one container.
- Add artifact retention policies and cleanup jobs for long-lived environments.
- Add auth and reviewer session controls if the demo becomes semi-public or persistent.
- Add deployment health checks that verify both the web process and worker loop are healthy after boot.
