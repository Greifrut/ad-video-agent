import path from "node:path";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
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

type GoogleGenAIClient = {
  models: {
    generateImages: (request: unknown) => Promise<unknown>;
  };
};

type GoogleGenAIModule = {
  GoogleGenAI: new (options: {
    vertexai: true;
    project: string;
    location: string;
    apiVersion?: string;
  }) => GoogleGenAIClient;
};

const loadGoogleGenAIModule = new Function("return import('@google/genai')") as () => Promise<GoogleGenAIModule>;

export type VertexGeminiFlashImageClientOptions = {
  project: string;
  location: string;
  outputRootDir: string;
  apiVersion?: string;
  createClient?: () => Promise<GoogleGenAIClient> | GoogleGenAIClient;
  now?: () => number;
};

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseImageGenerationResponse(payload: unknown): {
  imageBytes: string;
  mimeType: string;
  providerRef: string | null;
  width: number | null;
  height: number | null;
} {
  if (!isRecord(payload)) {
    throw new Error("vertex image generation returned an invalid payload");
  }

  const providerRef = readString(payload.responseId) ?? readString(payload.response_id) ?? null;
  const generatedImages = payload.generatedImages;
  if (!Array.isArray(generatedImages) || generatedImages.length === 0) {
    throw new Error("vertex image generation returned no generatedImages");
  }

  const firstImage = generatedImages[0];
  if (!isRecord(firstImage) || !isRecord(firstImage.image)) {
    throw new Error("vertex image generation returned malformed image payload");
  }

  const imageBytes = readString(firstImage.image.imageBytes) ?? readString(firstImage.image.image_bytes);
  if (!imageBytes) {
    throw new Error("vertex image generation returned no image bytes");
  }

  return {
    imageBytes,
    mimeType:
      readString(firstImage.image.mimeType) ??
      readString(firstImage.image.mime_type) ??
      "image/png",
    providerRef,
    width: readNumber(firstImage.image.width),
    height: readNumber(firstImage.image.height),
  };
}

function renderScenePrompt(request: GeminiSceneStillRequest): string {
  const sourceAssetsSummary = request.sourceAssets
    .map((asset) => {
      return `${asset.assetId} (${asset.width}x${asset.height}, ${asset.canonicalMime})`;
    })
    .join(", ");

  return [
    request.prompt.template,
    "",
    `Scene ID: ${request.scene.sceneId}`,
    `Scene type: ${request.scene.sceneType}`,
    `Narrative: ${request.scene.narrative}`,
    `Requested transform: ${request.scene.requestedTransform}`,
    `Approved source assets: ${sourceAssetsSummary}`,
  ].join("\n");
}

export function createVertexGeminiFlashImageClient(
  options: VertexGeminiFlashImageClientOptions,
): GeminiFlashImageClient {
  let clientPromise: Promise<GoogleGenAIClient> | null = null;
  const now = options.now ?? (() => Date.now());

  async function getClient(): Promise<GoogleGenAIClient> {
    if (!clientPromise) {
      clientPromise = (async () => {
        if (options.createClient) {
          return await options.createClient();
        }

        const genAiSdk = await loadGoogleGenAIModule();
        return new genAiSdk.GoogleGenAI({
          vertexai: true,
          project: options.project,
          location: options.location,
          apiVersion: options.apiVersion ?? "v1",
        });
      })();
    }

    return await clientPromise;
  }

  return {
    generateSceneStill: async (request) => {
      try {
        const client = await getClient();
        const response = await client.models.generateImages({
          model: request.model,
          prompt: renderScenePrompt(request),
          config: {
            numberOfImages: 1,
            aspectRatio: "16:9",
          },
        });

        const parsed = parseImageGenerationResponse(response);
        const stillBytes = Buffer.from(parsed.imageBytes, "base64");
        const stillSha = createHash("sha256").update(stillBytes).digest("hex");
        const extension = parsed.mimeType === "image/jpeg" ? "jpg" : "png";
        const stillDir = path.join(options.outputRootDir, "runs", request.runId, "stills");
        const stillFilename = `${request.scene.sceneId}-${randomUUID()}.${extension}`;
        const stillPath = path.join(stillDir, stillFilename);

        await fs.mkdir(stillDir, { recursive: true });
        await fs.writeFile(stillPath, stillBytes);

        const fallbackWidth = request.sourceAssets[0]?.width ?? 1280;
        const fallbackHeight = request.sourceAssets[0]?.height ?? 720;

        return {
          provider_job_reference:
            parsed.providerRef ??
            `vertex-gemini-${request.scene.sceneId}-${now()}`,
          still: {
            still_id: `${request.scene.sceneId}-${stillSha.slice(0, 12)}`,
            storage_path: stillPath,
            canonical_mime: parsed.mimeType,
            byte_size: stillBytes.byteLength,
            width: parsed.width ?? fallbackWidth,
            height: parsed.height ?? fallbackHeight,
            sha256: stillSha,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown vertex image adapter error";
        throw new Error(`vertex gemini generateSceneStill failed: ${message}`);
      }
    },
  };
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
