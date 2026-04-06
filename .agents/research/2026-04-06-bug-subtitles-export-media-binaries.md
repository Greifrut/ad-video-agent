# Subtitles Export Media Binary Investigation

## Symptom

Live `subtitles_export` crashed the worker with:

- `ffprobe failed for ...: spawn ffprobe ENOENT`

and the worker process exited instead of recording a failed run.

## Phase 1: Root Cause

- Manifestation:
  - [subtitles-export.ts](/Users/arturbunko/Documents/deal-pump/ad-video-agent/packages/shared/src/domain/subtitles-export.ts)
  - [engine.ts](/Users/arturbunko/Documents/deal-pump/ad-video-agent/packages/shared/src/run-engine/engine.ts)
- Root causes:
  - The default media runner spawned plain `ffmpeg` / `ffprobe` and assumed both existed in `PATH`.
  - On this machine neither binary was installed globally.
  - `probeMedia` threw on the failed spawn.
  - `processClaim` did not catch stage-handler exceptions, so the thrown error escaped to worker `main()` and terminated the process.

## Phase 2: Pattern

- Fixture export already works without system binaries because it uses a fake in-memory media runner.
- Live export used the real default runner with no fallback binary resolution.
- Bootstrap validation allows `REQUIRE_FFMPEG=false` locally, but the live export stage still needed binaries at runtime.

## Phase 3: Hypothesis

Hypothesis:

> If the default media runner resolves bundled FFmpeg/FFprobe binaries and the run engine catches stage exceptions, live subtitles export will stop crashing on missing system binaries.

Validation:

- Added bundled binary dependencies.
- Resolved and executed those binaries through the default media runner.
- Verified a real local `subtitles_export` smoke run succeeded with the default runner.

## Phase 4: Fix

- Added bundled binary dependencies:
  - `@ffmpeg-installer/ffmpeg`
  - `@ffprobe-installer/ffprobe`
- Updated the default media runner to:
  - prefer `FFMPEG_BIN` / `FFPROBE_BIN` when set
  - otherwise use bundled package binaries
  - best-effort `chmod` absolute paths before spawn so skipped install scripts do not leave `ffprobe` non-executable
- Hardened `processClaim` so thrown stage exceptions become `provider_failed` runs instead of crashing the worker process.
- Added regression coverage in:
  - [sqlite-run-engine.test.ts](/Users/arturbunko/Documents/deal-pump/ad-video-agent/tests/integration/sqlite-run-engine.test.ts)

## Verification

- `pnpm vitest run tests/integration/sqlite-run-engine.test.ts`
- `pnpm vitest run tests/integration/export.test.ts`
- `pnpm vitest run tests/unit/veo-video-client.test.ts tests/unit/live-provider-adapters.test.ts`
- `pnpm typecheck`
- Real smoke test with default runner and bundled binaries:
  - `createSubtitlesExportGenerator(...).generate({ fixture_mode: true, ... })`
  - outcome: `ok`

## Residual Risk

- Real live export still requires working media binaries; the fix now supplies them from dependencies for local/dev use.
- If a deployment strips optional native packages, `FFMPEG_BIN` / `FFPROBE_BIN` can be used as explicit overrides.
