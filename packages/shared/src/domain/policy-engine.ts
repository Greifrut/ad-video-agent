import type { ApprovedAssetManifest } from "./approved-assets";
import type { NormalizedBrief } from "./brief-schema";
import type { FailureReasonCode, PolicyOutcome } from "./contracts";

export interface ScenePolicyEvaluation {
  sceneId: string;
  outcome: PolicyOutcome;
  reasonCodes: FailureReasonCode[];
}

export interface PolicyEvaluation {
  outcome: PolicyOutcome;
  reasonCodes: FailureReasonCode[];
  scenes: ScenePolicyEvaluation[];
}

function classifyScene(
  brief: NormalizedBrief,
  scene: NormalizedBrief["scenes"][number],
  manifest: ApprovedAssetManifest,
): ScenePolicyEvaluation {
  const reasonCodes = new Set<FailureReasonCode>();
  const approvedAssets = new Map(manifest.assets.map((asset) => [asset.id, asset]));

  if (scene.generationMode === "text_only" && scene.visualCriticality === "brand_critical") {
    reasonCodes.add("invented_brand_critical_media");
  }

  if (scene.visualCriticality === "brand_critical" && scene.approvedAssetIds.length === 0) {
    reasonCodes.add("brand_critical_asset_required");
  }

  if (scene.approvedAssetIds.length === 0) {
    reasonCodes.add("brief_no_asset_match");
  }

  for (const assetId of scene.approvedAssetIds) {
    if (!approvedAssets.has(assetId)) {
      reasonCodes.add("asset_not_approved");
      continue;
    }

    const asset = approvedAssets.get(assetId);
    if (!asset) {
      reasonCodes.add("asset_not_approved");
      continue;
    }

    if (!asset.sceneSuitability.includes(scene.sceneType)) {
      reasonCodes.add("asset_scene_unsuitable");
    }

    if (!asset.allowedTransforms.includes(scene.requestedTransform)) {
      reasonCodes.add("asset_transform_not_allowed");
    }

    if (scene.visualCriticality === "brand_critical" && !asset.brandCritical) {
      reasonCodes.add("brand_critical_asset_required");
    }
  }

  if (brief.unresolvedQuestions.length > 0) {
    reasonCodes.add("brief_ambiguous_visual_intent");
  }

  const reasons = [...reasonCodes];
  const blockedReasons = new Set<FailureReasonCode>([
    "invented_brand_critical_media",
    "brand_critical_asset_required",
    "asset_not_approved",
    "external_asset_source_forbidden",
  ]);
  const isBlocked = reasons.some((reason) => blockedReasons.has(reason));

  return {
    sceneId: scene.sceneId,
    outcome: isBlocked ? "policy_blocked" : reasons.length > 0 ? "needs_clarification" : "ok",
    reasonCodes: reasons,
  };
}

export function evaluateBriefPolicy(
  brief: NormalizedBrief,
  manifest: ApprovedAssetManifest,
): PolicyEvaluation {
  const scenes = brief.scenes.map((scene) => classifyScene(brief, scene, manifest));
  const reasonCodes = [...new Set(scenes.flatMap((scene) => scene.reasonCodes))];

  const hasBlockedScene = scenes.some((scene) => scene.outcome === "policy_blocked");
  const hasClarifications = scenes.some((scene) => scene.outcome === "needs_clarification");

  return {
    outcome: hasBlockedScene ? "policy_blocked" : hasClarifications ? "needs_clarification" : "ok",
    reasonCodes,
    scenes,
  };
}
