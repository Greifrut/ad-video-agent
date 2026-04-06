import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { APPROVED_ASSET_BY_ID } from "./approved-assets";
import { parseNormalizedBrief, type NormalizedBrief } from "./brief-schema";

const DEFAULT_MODEL = "pre_generated_assets";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBriefFromPayload(payload: unknown): { ok: true; brief: NormalizedBrief } | { ok: false } {
  const rawCandidate = isRecord(payload) && "normalized_brief" in payload ? payload.normalized_brief : payload;
  const parsed = parseNormalizedBrief(rawCandidate);

  if (!parsed.ok) {
    return { ok: false };
  }

  return {
    ok: true,
    brief: parsed.value,
  };
}

function uniqueSourceAssetIds(brief: NormalizedBrief): string[] {
  return [...new Set(brief.scenes.flatMap((scene) => scene.approvedAssetIds))].sort();
}

export type PreGeneratedImageGeneratorOptions = {
  assetsRootDir?: string;
  model?: string;
};

export type PreGeneratedImageGeneratorResult =
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
      outcome: "needs_clarification" | "provider_failed";
      reason: string;
      reasonCodes: string[];
    };

export function createPreGeneratedImageGenerator(options: PreGeneratedImageGeneratorOptions) {
  const assetsRootDir = options.assetsRootDir ?? path.resolve(process.cwd(), "public/assets/approved");
  const model = options.model ?? DEFAULT_MODEL;

  return {
    generate: async (payload: unknown, runId: string): Promise<PreGeneratedImageGeneratorResult> => {
      const parsedBrief = parseBriefFromPayload(payload);
      if (!parsedBrief.ok) {
        return {
          outcome: "needs_clarification",
          reason: "normalized brief schema validation failed",
          reasonCodes: ["brief_invalid_schema"],
        };
      }

      const brief = parsedBrief.brief;
      if (brief.scenes.some((scene) => scene.approvedAssetIds.length === 0)) {
        return {
          outcome: "needs_clarification",
          reason: "image selection requires one local asset per scene",
          reasonCodes: ["brief_no_asset_match"],
        };
      }

      const derivedStills = [];

      for (const scene of brief.scenes) {
        const primaryAssetId = scene.approvedAssetIds[0];
        const asset = APPROVED_ASSET_BY_ID.get(primaryAssetId);
        if (!asset) {
          return {
            outcome: "provider_failed",
            reason: `selected asset missing in manifest: ${primaryAssetId}`,
            reasonCodes: ["asset_not_approved"],
          };
        }

        const filePath = path.join(assetsRootDir, asset.filename);
        let fileBytes: Buffer;
        try {
          fileBytes = await fs.readFile(filePath);
        } catch {
          return {
            outcome: "provider_failed",
            reason: `selected asset file missing on disk: ${asset.filename}`,
            reasonCodes: ["approved_asset_missing_on_disk"],
          };
        }

        derivedStills.push({
          scene_id: scene.sceneId,
          source_asset_ids: [...scene.approvedAssetIds],
          provider_job_reference: `local-asset-${scene.sceneId}`,
          still_id: randomUUID(),
          storage_path: filePath,
          canonical_mime: asset.canonicalMime,
          byte_size: fileBytes.byteLength,
          width: asset.dimensions.width,
          height: asset.dimensions.height,
          sha256: createHash("sha256").update(fileBytes).digest("hex"),
        });
      }

      return {
        outcome: "ok",
        providerRef: `local-assets-${runId}`,
        stageData: {
          image_generation: {
            prompt_metadata: {
              prompt_id: "use_pre_generated_scene_assets_v1",
              version: 1,
              template_hash: "static-assets-v1",
              model,
            },
            model_name: model,
            source_asset_ids: uniqueSourceAssetIds(brief),
            derived_stills: derivedStills,
          },
        },
      };
    },
  };
}
