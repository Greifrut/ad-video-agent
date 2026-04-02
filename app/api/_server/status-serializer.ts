import type { RunProjection, RunOutcome, RunPhase } from "@shared/index";

export type LockedRunStatusPayload = {
  runId: string;
  phase: RunPhase;
  outcome: RunOutcome;
  errorCode?: string;
  normalizedBrief?: unknown;
  selectedAssetIds?: string[];
  resultUrl?: string;
  provenanceUrl?: string;
};

type StageOutputEventPayload = {
  stage_output?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractStageOutput(projection: RunProjection, stageName: string): Record<string, unknown> | null {
  for (let index = projection.events.length - 1; index >= 0; index -= 1) {
    const event = projection.events[index];
    const stage = event.payload.stage;
    if (event.eventType !== "job_succeeded" || stage !== stageName) {
      continue;
    }

    const payload = event.payload as StageOutputEventPayload;
    if (payload.stage_output && isRecord(payload.stage_output)) {
      return payload.stage_output;
    }
  }

  return null;
}

function pickReasonCodeFromResult(result: Record<string, unknown> | null): string | undefined {
  if (!result) {
    return undefined;
  }

  const candidates: unknown[] = [];

  if (isRecord(result.validate_policy)) {
    candidates.push(result.validate_policy.reason_codes);
  }

  if (isRecord(result.image_generation)) {
    candidates.push(result.image_generation.reason_codes);
  }

  if (isRecord(result.video_generation)) {
    candidates.push(result.video_generation.reason_codes);
  }

  if (isRecord(result.normalize) && Array.isArray(result.normalize.reason_codes)) {
    candidates.push(result.normalize.reason_codes);
  }

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const firstCode = candidate.find((value): value is string => typeof value === "string");
      if (firstCode) {
        return firstCode;
      }
    }
  }

  return undefined;
}

function extractNormalizedBrief(projection: RunProjection): unknown {
  const normalizeOutput = extractStageOutput(projection, "normalize");
  if (normalizeOutput && isRecord(normalizeOutput.normalize) && normalizeOutput.normalize.normalized_brief) {
    return normalizeOutput.normalize.normalized_brief;
  }

  if (normalizeOutput && normalizeOutput.normalized_brief) {
    return normalizeOutput.normalized_brief;
  }

  if (projection.result && projection.result.normalized_brief) {
    return projection.result.normalized_brief;
  }

  return undefined;
}

function extractSelectedAssetIds(projection: RunProjection): string[] | undefined {
  const policyOutput = extractStageOutput(projection, "validate_policy");
  const maybeSelection = isRecord(policyOutput?.validate_policy)
    ? policyOutput.validate_policy.selected_asset_ids
    : undefined;

  if (Array.isArray(maybeSelection)) {
    return maybeSelection.filter((value): value is string => typeof value === "string");
  }

  if (
    projection.result &&
    isRecord(projection.result.validate_policy) &&
    Array.isArray(projection.result.validate_policy.selected_asset_ids)
  ) {
    return projection.result.validate_policy.selected_asset_ids.filter(
      (value): value is string => typeof value === "string",
    );
  }

  return undefined;
}

function extractArtifactUrls(projection: RunProjection): { resultUrl?: string; provenanceUrl?: string } {
  if (!projection.result || !isRecord(projection.result.subtitles_export)) {
    return {};
  }

  const artifactRoutes = projection.result.subtitles_export.artifact_routes;
  if (!isRecord(artifactRoutes)) {
    return {};
  }

  const finalRoute = isRecord(artifactRoutes.final_mp4) ? artifactRoutes.final_mp4.signed_path : undefined;
  const provenanceRoute = isRecord(artifactRoutes.provenance_json)
    ? artifactRoutes.provenance_json.signed_path
    : undefined;

  return {
    resultUrl: typeof finalRoute === "string" ? finalRoute : undefined,
    provenanceUrl: typeof provenanceRoute === "string" ? provenanceRoute : undefined,
  };
}

export function serializeRunStatus(projection: RunProjection): LockedRunStatusPayload {
  const status: LockedRunStatusPayload = {
    runId: projection.runId,
    phase: projection.phase,
    outcome: projection.outcome,
  };

  const normalizedBrief = extractNormalizedBrief(projection);
  if (normalizedBrief !== undefined) {
    status.normalizedBrief = normalizedBrief;
  }

  const selectedAssetIds = extractSelectedAssetIds(projection);
  if (selectedAssetIds && selectedAssetIds.length > 0) {
    status.selectedAssetIds = selectedAssetIds;
  }

  const { resultUrl, provenanceUrl } = extractArtifactUrls(projection);
  if (resultUrl) {
    status.resultUrl = resultUrl;
  }
  if (provenanceUrl) {
    status.provenanceUrl = provenanceUrl;
  }

  if (projection.outcome !== "none" && projection.outcome !== "ok") {
    const reasonCode = pickReasonCodeFromResult(projection.result);
    status.errorCode = reasonCode ?? projection.outcome;
  }

  return status;
}
