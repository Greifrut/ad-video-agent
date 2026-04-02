import { APPROVED_ASSET_MANIFEST } from "../domain/approved-assets";
import { BRIEF_SCHEMA_VERSION, parseNormalizedBrief, type NormalizedBrief } from "../domain/brief-schema";
import { evaluateBriefPolicy } from "../domain/policy-engine";
import type { StageHandler } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractInputBrief(payload: unknown): string {
  if (typeof payload === "string") {
    return payload.trim();
  }

  if (isRecord(payload)) {
    if (typeof payload.brief === "string") {
      return payload.brief.trim();
    }

    if (typeof payload.user_brief === "string") {
      return payload.user_brief.trim();
    }
  }

  return "";
}

function normalizeBriefForFixture(inputBrief: string, runId: string): NormalizedBrief {
  const briefText = inputBrief.length > 0 ? inputBrief : "Create a simple fixture ad";

  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    briefId: `fixture-${runId}`,
    campaignName: "Fixture runtime campaign",
    objective: briefText,
    language: "en",
    aspectRatio: "16:9",
    unresolvedQuestions: [],
    scenes: [
      {
        sceneId: "scene-intro",
        sceneType: "intro",
        visualCriticality: "supporting",
        narrative: `${briefText}. Opening reveal with approved logo and studio background.`,
        desiredTags: ["logo", "background"],
        approvedAssetIds: ["brand-wordmark-primary", "studio-gradient-backdrop"],
        generationMode: "asset_derived",
        requestedTransform: "overlay",
        durationSeconds: 5,
      },
      {
        sceneId: "scene-product",
        sceneType: "product_focus",
        visualCriticality: "brand_critical",
        narrative: "Product hero frame with controlled motion and packshot emphasis.",
        desiredTags: ["product", "packshot"],
        approvedAssetIds: ["product-can-classic-packshot"],
        generationMode: "asset_derived",
        requestedTransform: "animate",
        durationSeconds: 6,
      },
    ],
  };
}

function collectSelectedAssetIds(brief: NormalizedBrief): string[] {
  const unique = new Set<string>();
  for (const scene of brief.scenes) {
    for (const assetId of scene.approvedAssetIds) {
      unique.add(assetId);
    }
  }

  return [...unique].sort();
}

export function createRuntimeNormalizeStageHandler(): StageHandler {
  return async (context) => {
    const inputBrief = extractInputBrief(context.payload);
    const normalizedBrief = normalizeBriefForFixture(inputBrief, context.runId);

    return {
      type: "success",
      data: {
        normalize: {
          prompt_metadata: {
            prompt_id: "normalize_brief_fixture_runtime",
            version: 1,
            template_hash: "fixture-runtime-v1",
            model: "fixture-runtime",
          },
          repair_attempted: false,
          sanitized_brief: inputBrief,
          normalized_brief: normalizedBrief,
          reason_codes: [],
        },
        normalized_brief: normalizedBrief,
      },
      providerRef: `fixture-normalize-${context.runId}`,
    };
  };
}

export function createRuntimeValidatePolicyStageHandler(): StageHandler {
  return async (context) => {
    const payload = isRecord(context.payload) ? context.payload : {};
    const candidateBrief = "normalized_brief" in payload ? payload.normalized_brief : context.payload;

    const parsed = parseNormalizedBrief(candidateBrief);
    if (!parsed.ok) {
      return {
        type: "terminal_outcome",
        outcome: "needs_clarification",
        reason: "normalized brief schema validation failed before validate_policy stage",
        data: {
          validate_policy: {
            reason_codes: parsed.reasonCodes,
          },
        },
      };
    }

    const policy = evaluateBriefPolicy(parsed.value, APPROVED_ASSET_MANIFEST);
    const selectedAssetIds = collectSelectedAssetIds(parsed.value);

    if (policy.outcome === "ok") {
      return {
        type: "success",
        data: {
          validate_policy: {
            selected_asset_ids: selectedAssetIds,
            reason_codes: [],
          },
          normalized_brief: parsed.value,
        },
      };
    }

    return {
      type: "terminal_outcome",
      outcome: policy.outcome,
      reason: `policy evaluation returned ${policy.outcome}`,
      data: {
        validate_policy: {
          selected_asset_ids: selectedAssetIds,
          reason_codes: policy.reasonCodes,
        },
        normalized_brief: parsed.value,
      },
    };
  };
}
