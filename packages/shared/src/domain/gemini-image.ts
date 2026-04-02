import path from "node:path";
import { APPROVED_ASSET_BY_ID, APPROVED_ASSET_MANIFEST } from "./approved-assets";
import { validateAssetRecordIntegrity } from "./asset-integrity";
import { parseNormalizedBrief, type NormalizedBrief, type NormalizedScene } from "./brief-schema";
import type { FailureReasonCode } from "./contracts";
import { evaluateBriefPolicy } from "./policy-engine";
import {
  GEMINI_FLASH_IMAGE_PROMPT_ID,
  getPromptRegistryEntry,
  type PromptRegistryEntry,
} from "./prompt-registry";

const DEFAULT_MODEL = "gemini-2.5-flash-image";

const EXTERNAL_ASSET_URL_FIELD = /(asset|source).*(url|uri)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExternalHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function hasExternalAssetUrlInput(input: unknown): boolean {
  if (typeof input === "string") {
    return false;
  }

  if (Array.isArray(input)) {
    return input.some((entry) => hasExternalAssetUrlInput(entry));
  }

  if (!isRecord(input)) {
    return false;
  }

  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && EXTERNAL_ASSET_URL_FIELD.test(key) && isExternalHttpUrl(value)) {
      return true;
    }

    if (hasExternalAssetUrlInput(value)) {
      return true;
    }
  }

  return false;
}

function parseBriefFromPayload(payload: unknown): { ok: true; brief: NormalizedBrief } | { ok: false; reasonCodes: FailureReasonCode[] } {
  const rawCandidate = isRecord(payload) && "normalized_brief" in payload ? payload.normalized_brief : payload;
  const parsed = parseNormalizedBrief(rawCandidate);

  if (!parsed.ok) {
    return {
      ok: false,
      reasonCodes: parsed.reasonCodes,
    };
  }

  return {
    ok: true,
    brief: parsed.value,
  };
}

function uniqueSourceAssetIds(brief: NormalizedBrief): string[] {
  return [...new Set(brief.scenes.flatMap((scene) => scene.approvedAssetIds))];
}

function hasMissingApprovedAssetIds(brief: NormalizedBrief): boolean {
  return brief.scenes.some((scene) => scene.approvedAssetIds.length === 0);
}

function hasExternalAssetIds(brief: NormalizedBrief): boolean {
  return brief.scenes.some((scene) => scene.approvedAssetIds.some((assetId) => isExternalHttpUrl(assetId)));
}

function promptMetadata(prompt: PromptRegistryEntry, model: string) {
  return {
    prompt_id: prompt.prompt_id,
    version: prompt.version,
    template_hash: prompt.template_hash,
    model,
  };
}

export type GeminiSceneStillRequest = {
  runId: string;
  scene: Pick<NormalizedScene, "sceneId" | "sceneType" | "narrative" | "requestedTransform">;
  sourceAssets: Array<{
    assetId: string;
    filePath: string;
    canonicalMime: string;
    byteSize: number;
    width: number;
    height: number;
  }>;
  prompt: {
    prompt_id: string;
    version: number;
    template_hash: string;
    template: string;
  };
  model: string;
};

export type GeminiSceneStillResponse = {
  provider_job_reference: string;
  still: {
    still_id: string;
    storage_path: string;
    canonical_mime: string;
    byte_size: number;
    width: number;
    height: number;
    sha256: string;
  };
};

export interface GeminiFlashImageClient {
  generateSceneStill: (request: GeminiSceneStillRequest) => Promise<GeminiSceneStillResponse>;
}

export type GeminiImageGeneratorOptions = {
  client: GeminiFlashImageClient;
  model?: string;
  approvedAssetsRootDir?: string;
};

export type GeminiImageGeneratorResult =
  | {
      outcome: "ok";
      providerRef: string | null;
      stageData: {
        image_generation: {
          prompt_metadata: {
            prompt_id: string;
            version: number;
            template_hash: string;
            model: string;
          };
          model_name: string;
          source_asset_ids: string[];
          derived_stills: Array<{
            scene_id: string;
            source_asset_ids: string[];
            provider_job_reference: string;
            still_id: string;
            storage_path: string;
            canonical_mime: string;
            byte_size: number;
            width: number;
            height: number;
            sha256: string;
          }>;
        };
      };
    }
  | {
      outcome: "policy_blocked" | "needs_clarification";
      reason: string;
      reasonCodes: FailureReasonCode[];
    };

export function createGeminiImageGenerator(options: GeminiImageGeneratorOptions): {
  generate: (payload: unknown, runId: string) => Promise<GeminiImageGeneratorResult>;
} {
  const model = options.model ?? DEFAULT_MODEL;
  const approvedAssetsRootDir =
    options.approvedAssetsRootDir ?? path.resolve(process.cwd(), "public/assets/approved");
  const prompt = getPromptRegistryEntry(GEMINI_FLASH_IMAGE_PROMPT_ID);

  return {
    generate: async (payload, runId) => {
      if (hasExternalAssetUrlInput(payload)) {
        return {
          outcome: "policy_blocked",
          reason: "external asset URLs are forbidden for image generation",
          reasonCodes: ["external_asset_source_forbidden"],
        };
      }

      const parsedBrief = parseBriefFromPayload(payload);
      if (!parsedBrief.ok) {
        return {
          outcome: "needs_clarification",
          reason: "normalized brief schema validation failed",
          reasonCodes: parsedBrief.reasonCodes,
        };
      }

      const brief = parsedBrief.brief;
      if (hasExternalAssetIds(brief)) {
        return {
          outcome: "policy_blocked",
          reason: "approvedAssetIds must not contain remote URLs",
          reasonCodes: ["external_asset_source_forbidden"],
        };
      }

      if (hasMissingApprovedAssetIds(brief)) {
        return {
          outcome: "policy_blocked",
          reason: "image generation requires approved asset IDs for every scene",
          reasonCodes: ["brief_no_asset_match"],
        };
      }

      const policy = evaluateBriefPolicy(brief, APPROVED_ASSET_MANIFEST);
      if (policy.outcome !== "ok") {
        return {
          outcome: policy.outcome,
          reason: `policy evaluation rejected image generation: ${policy.reasonCodes.join(",")}`,
          reasonCodes: policy.reasonCodes,
        };
      }

      const sourceAssetIds = uniqueSourceAssetIds(brief);
      for (const assetId of sourceAssetIds) {
        const asset = APPROVED_ASSET_BY_ID.get(assetId);
        if (!asset) {
          return {
            outcome: "policy_blocked",
            reason: `asset is not approved: ${assetId}`,
            reasonCodes: ["asset_not_approved"],
          };
        }

        const integrity = await validateAssetRecordIntegrity(asset, approvedAssetsRootDir);
        if (!integrity.ok) {
          return {
            outcome: "policy_blocked",
            reason: `asset integrity validation failed for ${assetId}`,
            reasonCodes: integrity.failures.map((failure) => failure.reasonCode),
          };
        }
      }

      const promptMeta = promptMetadata(prompt, model);
      const stills: Array<{
        scene_id: string;
        source_asset_ids: string[];
        provider_job_reference: string;
        still_id: string;
        storage_path: string;
        canonical_mime: string;
        byte_size: number;
        width: number;
        height: number;
        sha256: string;
      }> = [];

      for (const scene of brief.scenes) {
        const sourceAssets = scene.approvedAssetIds.map((assetId) => {
          const asset = APPROVED_ASSET_BY_ID.get(assetId);
          if (!asset) {
            throw new Error(`approved asset missing in manifest map: ${assetId}`);
          }

          return {
            assetId,
            filePath: path.join(approvedAssetsRootDir, asset.filename),
            canonicalMime: asset.canonicalMime,
            byteSize: asset.byteSize,
            width: asset.dimensions.width,
            height: asset.dimensions.height,
          };
        });

        const response = await options.client.generateSceneStill({
          runId,
          model,
          scene: {
            sceneId: scene.sceneId,
            sceneType: scene.sceneType,
            narrative: scene.narrative,
            requestedTransform: scene.requestedTransform,
          },
          sourceAssets,
          prompt: {
            prompt_id: prompt.prompt_id,
            version: prompt.version,
            template_hash: prompt.template_hash,
            template: prompt.template,
          },
        });

        stills.push({
          scene_id: scene.sceneId,
          source_asset_ids: [...scene.approvedAssetIds],
          provider_job_reference: response.provider_job_reference,
          still_id: response.still.still_id,
          storage_path: response.still.storage_path,
          canonical_mime: response.still.canonical_mime,
          byte_size: response.still.byte_size,
          width: response.still.width,
          height: response.still.height,
          sha256: response.still.sha256,
        });
      }

      return {
        outcome: "ok",
        providerRef: stills[0]?.provider_job_reference ?? null,
        stageData: {
          image_generation: {
            prompt_metadata: promptMeta,
            model_name: model,
            source_asset_ids: sourceAssetIds,
            derived_stills: stills,
          },
        },
      };
    },
  };
}
