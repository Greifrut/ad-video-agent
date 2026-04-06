import {
  APPROVED_ASSET_MANIFEST,
  type ApprovedAssetRecord,
} from "../domain/approved-assets";
import { BRIEF_SCHEMA_VERSION, parseNormalizedBrief, type NormalizedBrief } from "../domain/brief-schema";
import type { AssetTag } from "../domain/contracts";
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
    aspectRatio: "4:9",
    unresolvedQuestions: [],
    scenes: [
      {
        sceneId: "scene-intro",
        sceneType: "intro",
        visualCriticality: "supporting",
        narrative: `${briefText}. Open on the spokesperson hook frame.`,
        desiredTags: ["hero", "social", "background"],
        approvedAssetIds: ["hook-spokeswoman-dealpump"],
        generationMode: "asset_derived",
        requestedTransform: "overlay",
        durationSeconds: 5,
      },
      {
        sceneId: "scene-product",
        sceneType: "product_focus",
        visualCriticality: "brand_critical",
        narrative: "Show the product demo close-up with clear ecommerce value.",
        desiredTags: ["product", "packshot"],
        approvedAssetIds: ["product-demo-closeup"],
        generationMode: "asset_derived",
        requestedTransform: "animate",
        durationSeconds: 5,
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

function inferDesiredTags(scene: NormalizedBrief["scenes"][number], brief: NormalizedBrief): AssetTag[] {
  const text = `${brief.objective} ${scene.narrative}`.toLowerCase();
  const inferred = new Set<AssetTag>(scene.desiredTags);

  const keywordMap: Array<{ tag: AssetTag; patterns: string[] }> = [
    { tag: "product", patterns: ["product", "deal pump", "ecommerce", "interface", "device"] },
    { tag: "packshot", patterns: ["packshot", "close-up", "demo"] },
    { tag: "social", patterns: ["social", "testimonial", "proof", "creator"] },
    { tag: "background", patterns: ["background", "studio", "lifestyle"] },
    { tag: "hero", patterns: ["hook", "best", "cta", "why", "direct to camera"] },
  ];

  for (const { tag, patterns } of keywordMap) {
    if (patterns.some((pattern) => text.includes(pattern))) {
      inferred.add(tag);
    }
  }

  return [...inferred];
}

function scoreAssetForScene(
  asset: ApprovedAssetRecord,
  scene: NormalizedBrief["scenes"][number],
  desiredTags: readonly AssetTag[],
): number {
  let score = 0;
  const sceneText = scene.narrative.toLowerCase();

  for (const tag of desiredTags) {
    if (asset.tags.includes(tag)) {
      score += 5;
    }
  }

  if (asset.sceneSuitability.includes(scene.sceneType)) {
    score += 6;
  }

  if (
    scene.sceneType === "intro" &&
    asset.id === "hook-spokeswoman-dealpump" &&
    /(presenter|introduc|hand gestures|studio movement|host|spokesperson)/i.test(sceneText)
  ) {
    score += 12;
  }

  if (
    scene.sceneType === "intro" &&
    asset.id === "product-demo-closeup" &&
    /(product|interface|device|demo|screen)/i.test(sceneText)
  ) {
    score += 10;
  }

  if (scene.sceneType === "intro" && asset.id === "social-proof-lifestyle") {
    score += 6;
  }

  if (scene.sceneType === "product_focus" && asset.id === "product-demo-closeup") {
    score += 10;
  }

  if (scene.sceneType === "background_plate" && asset.id === "social-proof-lifestyle") {
    score += 10;
  }

  if (scene.sceneType === "cta" && asset.id === "closing-cta-packshot") {
    score += 10;
  }

  return score;
}

function selectAssetForScene(scene: NormalizedBrief["scenes"][number], brief: NormalizedBrief): string[] {
  const desiredTags = inferDesiredTags(scene, brief);
  const compatibleAssets = APPROVED_ASSET_MANIFEST.assets.filter((asset) => {
    return (
      asset.sceneSuitability.includes(scene.sceneType) &&
      asset.allowedTransforms.includes(scene.requestedTransform)
    );
  });

  const bestMatch = compatibleAssets
    .map((asset) => ({ asset, score: scoreAssetForScene(asset, scene, desiredTags) }))
    .sort((left, right) => right.score - left.score)[0]?.asset;

  return bestMatch ? [bestMatch.id] : [];
}

function enrichApprovedAssetsForRuntime(brief: NormalizedBrief): NormalizedBrief {
  return {
    ...brief,
    scenes: brief.scenes.map((scene) => {
      const selectedAssets =
        scene.approvedAssetIds.length > 0
          ? scene.approvedAssetIds.slice(0, 1)
          : selectAssetForScene(scene, brief);

      if (selectedAssets.length === 0) {
        return {
          ...scene,
          approvedAssetIds: selectedAssets,
        };
      }

      return {
        ...scene,
        approvedAssetIds: selectedAssets,
        generationMode: "asset_derived",
      };
    }),
  };
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

    const enrichedBrief = enrichApprovedAssetsForRuntime(parsed.value);
    const selectedAssetIds = collectSelectedAssetIds(enrichedBrief);

    const hasMissingAssets = enrichedBrief.scenes.some((scene) => scene.approvedAssetIds.length === 0);

    if (hasMissingAssets) {
      return {
        type: "terminal_outcome",
        outcome: "needs_clarification",
        reason: "asset selection could not map every scene to a predefined image",
        data: {
          validate_policy: {
            selected_asset_ids: selectedAssetIds,
            reason_codes: ["brief_no_asset_match"],
          },
          normalized_brief: enrichedBrief,
        },
      };
    }

    return {
      type: "success",
      data: {
        validate_policy: {
          selected_asset_ids: selectedAssetIds,
          reason_codes: [],
        },
        normalized_brief: enrichedBrief,
      },
    };
  };
}
