# Veo Poll Parser Investigation

## Symptom

Live `video_generation` runs fail with:

- `veo provider failure for scene scene_1: vertex veo operation completed without generated videos`

even though the Vertex long-running operation reports `done: true`.

## Phase 1: Root Cause

- Manifestation: [packages/shared/src/domain/veo-video.ts](/Users/arturbunko/Documents/deal-pump/ad-video-agent/packages/shared/src/domain/veo-video.ts) in `parseOperationStatus`.
- Failure mechanism:
  - `getSceneVideoGenerationStatus` polls Veo with a reconstructed operation object.
  - The reconstructed object uses a no-op `_fromAPIResponse`, so raw Vertex payloads are passed through without SDK normalization.
  - Raw Vertex poll responses use `response.videos[*]` with `bytesBase64Encoded` or `gcsUri`.
  - The parser only looked for `response.generatedVideos[*]` or `response.video`, so it concluded no videos were present and returned a fatal provider failure.
- Introduction point: live provider support landed in commit `8d389be` (`feat: Add live provider mode`).

## Phase 2: Pattern

- Working shapes already supported:
  - SDK-normalized `response.generatedVideos[*].video`
  - direct `response.video`
- Missing raw Vertex shapes:
  - `response.videos[*].bytesBase64Encoded`
  - `response.videos[*].gcsUri`

## Phase 3: Hypothesis

Hypothesis:

> The poll parser is rejecting successful raw Vertex responses because it only accepts SDK-normalized video fields.

Test:

- Added a unit regression with a raw Vertex payload:
  - `response.videos[0].bytesBase64Encoded`

Result:

- Reproduced the failure before the parser change.
- Passed after teaching the parser to accept raw Vertex `videos` entries and `bytesBase64Encoded`.

## Phase 4: Fix

- Added `bytesBase64Encoded` support in `readVideoBytes`.
- Added `readGeneratedVideos` to normalize:
  - `response.generatedVideos`
  - `response.video`
  - `response.videos`
- Added regression coverage in:
  - [tests/unit/veo-video-client.test.ts](/Users/arturbunko/Documents/deal-pump/ad-video-agent/tests/unit/veo-video-client.test.ts)

## Verification

- `pnpm vitest run tests/unit/veo-video-client.test.ts`
- `pnpm vitest run tests/unit/live-provider-adapters.test.ts`
- `pnpm vitest run tests/integration/veo-adapter.test.ts`

## Residual Risk

- `gs://` output URIs are still treated as unsupported download locations in the current adapter.
- That is separate from the observed bug, but it can become the next failure mode if Veo starts returning Cloud Storage output locations instead of inline bytes.
