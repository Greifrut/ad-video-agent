import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseNormalizedBrief } from "./brief-schema";
import type { FailureReasonCode } from "./contracts";
import {
  getPromptRegistryEntry,
  VEO_IMAGE_TO_VIDEO_PROMPT_ID,
  type PromptRegistryEntry,
} from "./prompt-registry";

const DEFAULT_MODEL = "veo-3.1-fast-generate-001";
const POLLING_SCHEDULE_MS = [10_000, 20_000, 30_000] as const;
const MAX_POLL_INTERVAL_MS = 30_000;
const MAX_SCENE_WALL_CLOCK_MS = 15 * 60 * 1_000;
const SUPPORTED_IMAGE_TO_VIDEO_DURATIONS = [4, 6, 8] as const;

type GoogleGenAIVideoClient = {
  models: {
    generateVideos: (request: unknown) => Promise<unknown>;
  };
  operations: {
    getVideosOperation: (request: unknown) => Promise<unknown>;
  };
};

type GoogleGenAIModule = {
  GoogleGenAI: new (options: {
    vertexai: true;
    project: string;
    location: string;
    apiVersion?: string;
  }) => GoogleGenAIVideoClient;
};

const loadGoogleGenAIModule = new Function(
  "return import('@google/genai')",
) as () => Promise<GoogleGenAIModule>;

type PollingClock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDerivedStills(
  payload: unknown,
):
  | { ok: true; stills: Array<Record<string, unknown>> }
  | { ok: false; reasonCodes: FailureReasonCode[] } {
  if (!isRecord(payload)) {
    return { ok: false, reasonCodes: ["brief_missing_required_field"] };
  }

  const stageOutputs = payload.stage_outputs;
  if (!isRecord(stageOutputs)) {
    return { ok: false, reasonCodes: ["brief_missing_required_field"] };
  }

  const imageGenerationStage = stageOutputs.image_generation;
  if (!isRecord(imageGenerationStage)) {
    return { ok: false, reasonCodes: ["brief_missing_required_field"] };
  }

  const imageGenerationPayload = imageGenerationStage.image_generation;
  if (!isRecord(imageGenerationPayload)) {
    return { ok: false, reasonCodes: ["brief_missing_required_field"] };
  }

  const stills = imageGenerationPayload.derived_stills;
  if (!Array.isArray(stills) || stills.length === 0) {
    return { ok: false, reasonCodes: ["brand_critical_asset_required"] };
  }

  return {
    ok: true,
    stills: stills.filter((entry): entry is Record<string, unknown> =>
      isRecord(entry),
    ),
  };
}

function promptMetadata(prompt: PromptRegistryEntry, model: string) {
  return {
    prompt_id: prompt.prompt_id,
    version: prompt.version,
    template_hash: prompt.template_hash,
    model,
  };
}

function classifyTransientError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    retryable?: boolean;
    transient?: boolean;
    code?: string;
    status?: number;
    message?: string;
  };

  if (candidate.retryable === true || candidate.transient === true) {
    return true;
  }

  if (typeof candidate.status === "number") {
    return candidate.status === 429 || candidate.status >= 500;
  }

  if (typeof candidate.code === "string") {
    return ["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(candidate.code);
  }

  const message = candidate.message ?? "";
  return /(timeout|temporar|rate limit|unavailable|overloaded)/i.test(message);
}

function getPollingDelayMs(attemptIndex: number): number {
  return POLLING_SCHEDULE_MS[attemptIndex] ?? MAX_POLL_INTERVAL_MS;
}

export type VeoSceneVideoStartRequest = {
  runId: string;
  scene: {
    sceneId: string;
    sceneType: string;
    narrative: string;
    durationSeconds: number;
  };
  prompt: {
    prompt_id: string;
    version: number;
    template_hash: string;
    template: string;
  };
  model: string;
  firstFrame: {
    stillId: string;
    storagePath: string;
    canonicalMime: string;
    width: number;
    height: number;
    sha256: string;
  };
  sourceAssetIds: string[];
};

export type VeoSceneVideoStatusRequest = {
  providerJobReference: string;
};

export type VeoSceneVideoStatusResponse =
  | {
      status: "queued" | "in_progress";
      progressPercent?: number;
    }
  | {
      status: "succeeded";
      clip: {
        clip_id: string;
        storage_path: string;
        canonical_mime: string;
        byte_size: number;
        duration_seconds: number;
        fps: number;
        width: number;
        height: number;
        sha256: string;
      };
      latencyMs?: number;
    }
  | {
      status: "failed";
      reason: string;
      reasonCode?: string;
      retryable?: boolean;
    };

export interface VeoVideoClient {
  startSceneVideoGeneration: (
    request: VeoSceneVideoStartRequest,
  ) => Promise<{ provider_job_reference: string }>;
  getSceneVideoGenerationStatus: (
    request: VeoSceneVideoStatusRequest,
  ) => Promise<VeoSceneVideoStatusResponse>;
}

export type VertexVeoVideoClientOptions = {
  project: string;
  location: string;
  apiVersion?: string;
  outputRootDir: string;
  createClient?: () => Promise<GoogleGenAIVideoClient> | GoogleGenAIVideoClient;
  fetchBinary?: (url: string) => Promise<Buffer>;
};

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isLocalFilePath(candidate: string): boolean {
  return !candidate.includes("://");
}

function renderScenePrompt(request: VeoSceneVideoStartRequest): string {
  return [
    request.prompt.template,
    "",
    `Scene ID: ${request.scene.sceneId}`,
    `Scene type: ${request.scene.sceneType}`,
    `Narrative: ${sanitizeNarrativeForVeo(request.scene.narrative)}`,
    `Duration seconds: ${request.scene.durationSeconds}`,
    `First frame still ID: ${request.firstFrame.stillId}`,
    `First frame SHA256: ${request.firstFrame.sha256}`,
    `Source asset IDs: ${request.sourceAssetIds.join(",")}`,
  ].join("\n");
}

function sanitizeNarrativeForVeo(narrative: string): string {
  return narrative
    .replace(/\bwoman\b/gi, "presenter")
    .replace(/\bman\b/gi, "presenter")
    .replace(/speaking straight to camera/gi, "presenting in a clean studio")
    .replace(/speaks directly to camera/gi, "appears in a clean studio")
    .replace(/direct-response/gi, "product-demo")
    .replace(/social-proof/gi, "positive lifestyle")
    .replace(/call to action/gi, "closing product frame")
    .replace(/\bbest\b/gi, "strong")
    .replace(/try .*? now/gi, "show the product clearly")
    .replace(/why .*? is the /gi, "introducing ")
    .trim();
}

function inferVeoAspectRatio(width: number, height: number): "9:16" | "16:9" | "1:1" {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return "9:16";
  }

  const ratio = width / height;
  if (Math.abs(ratio - 1) < 0.1) {
    return "1:1";
  }

  return ratio < 1 ? "9:16" : "16:9";
}

function readOperationName(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  return readString(payload.name);
}

function createRestorableVideosOperation(name: string): {
  name: string;
  _fromAPIResponse: (parameters: { apiResponse: unknown }) => unknown;
} {
  return {
    name,
    _fromAPIResponse: ({ apiResponse }) => apiResponse,
  };
}

function quantizeSceneDurationForVeo(requestedDuration: number): 4 | 6 | 8 {
  const roundedDuration = Math.max(1, Math.min(10, Math.round(requestedDuration)));

  return SUPPORTED_IMAGE_TO_VIDEO_DURATIONS.reduce((bestDuration, candidate) => {
    const bestDistance = Math.abs(bestDuration - roundedDuration);
    const candidateDistance = Math.abs(candidate - roundedDuration);

    if (candidateDistance < bestDistance) {
      return candidate;
    }

    if (candidateDistance === bestDistance) {
      return Math.min(bestDuration, candidate) as 4 | 6 | 8;
    }

    return bestDuration;
  });
}

async function defaultFetchBinary(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed (${response.status})`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function readVideoBytes(video: Record<string, unknown>): Buffer | null {
  const encodedBytes =
    readString(video.videoBytes) ??
    readString(video.video_bytes) ??
    readString(video.bytesBase64Encoded) ??
    readString(video.bytes) ??
    readString(video.inlineBytes) ??
    readString(video.inline_bytes);

  if (!encodedBytes) {
    return null;
  }

  return Buffer.from(encodedBytes, "base64");
}

function readGeneratedVideos(
  response: Record<string, unknown>,
): Array<Record<string, unknown>> {
  if (Array.isArray(response.generatedVideos)) {
    return response.generatedVideos.filter((entry): entry is Record<string, unknown> =>
      isRecord(entry),
    );
  }

  if (Array.isArray(response.videos)) {
    return response.videos
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((video) => ({ video }));
  }

  if (isRecord(response.video)) {
    return [{ video: response.video }];
  }

  return [];
}

function clipCachePath(
  outputRootDir: string,
  providerJobReference: string,
): string {
  const providerHash = createHash("sha256")
    .update(providerJobReference)
    .digest("hex");
  return path.join(
    outputRootDir,
    "provider-cache",
    "veo",
    `${providerHash}.mp4`,
  );
}

async function parseOperationStatus(
  payload: unknown,
  providerJobReference: string,
  outputRootDir: string,
  fetchBinary: (url: string) => Promise<Buffer>,
): Promise<VeoSceneVideoStatusResponse> {
  if (!isRecord(payload)) {
    throw new Error("vertex veo operation payload is invalid");
  }

  const done = payload.done === true;
  if (!done) {
    return {
      status: "in_progress",
    };
  }

  if (isRecord(payload.error)) {
    const message =
      readString(payload.error.message) ?? "vertex veo operation failed";
    return {
      status: "failed",
      reason: message,
      reasonCode: readString(payload.error.code) ?? undefined,
      retryable: false,
    };
  }

  const response = payload.response;
  if (!isRecord(response)) {
    return {
      status: "failed",
      reason: "vertex veo operation completed without generated videos",
      retryable: false,
    };
  }

  const generatedVideos = readGeneratedVideos(response);

  if (generatedVideos.length === 0) {
    const filteredReasons = Array.isArray(response.raiMediaFilteredReasons)
      ? response.raiMediaFilteredReasons.filter((value): value is string => typeof value === "string")
      : [];
    const filteredReasonMessage = filteredReasons.length > 0
      ? `vertex veo operation completed without generated videos (${filteredReasons.join(", ")})`
      : "vertex veo operation completed without generated videos";

    return {
      status: "failed",
      reason: filteredReasonMessage,
      reasonCode: filteredReasons[0],
      retryable: false,
    };
  }

  const firstGeneratedVideo = generatedVideos[0];
  if (!isRecord(firstGeneratedVideo) || !isRecord(firstGeneratedVideo.video)) {
    return {
      status: "failed",
      reason: "vertex veo operation video payload was malformed",
      retryable: false,
    };
  }

  const videoUri =
    readString(firstGeneratedVideo.video.uri) ??
    readString(firstGeneratedVideo.video.gcsUri);
  if (!videoUri) {
    const embeddedBytes = readVideoBytes(firstGeneratedVideo.video);
    if (!embeddedBytes) {
      return {
        status: "failed",
        reason:
          "vertex veo operation did not provide downloadable video content",
        retryable: false,
      };
    }

    const localPath = clipCachePath(outputRootDir, providerJobReference);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, embeddedBytes);
    const sha256 = createHash("sha256").update(embeddedBytes).digest("hex");

    return {
      status: "succeeded",
      clip: {
        clip_id: path.basename(localPath, ".mp4"),
        storage_path: localPath,
        canonical_mime: "video/mp4",
        byte_size: embeddedBytes.byteLength,
        duration_seconds:
          readNumber(firstGeneratedVideo.video.durationSeconds) ?? 5,
        fps: readNumber(firstGeneratedVideo.video.fps) ?? 24,
        width: readNumber(firstGeneratedVideo.video.width) ?? 1280,
        height: readNumber(firstGeneratedVideo.video.height) ?? 720,
        sha256,
      },
    };
  }

  if (!/^https?:\/\//i.test(videoUri)) {
    return {
      status: "failed",
      reason: `vertex veo returned unsupported video URI scheme: ${videoUri}`,
      retryable: false,
    };
  }

  const localPath = clipCachePath(outputRootDir, providerJobReference);
  let videoBytes: Buffer;
  try {
    videoBytes = await fs.readFile(localPath);
  } catch {
    videoBytes = await fetchBinary(videoUri);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, videoBytes);
  }

  const durationSeconds =
    readNumber(firstGeneratedVideo.video.durationSeconds) ?? 5;
  const width = readNumber(firstGeneratedVideo.video.width) ?? 1280;
  const height = readNumber(firstGeneratedVideo.video.height) ?? 720;
  const fps = readNumber(firstGeneratedVideo.video.fps) ?? 24;
  const sha256 = createHash("sha256").update(videoBytes).digest("hex");
  const clipId = path.basename(localPath, ".mp4");

  return {
    status: "succeeded",
    clip: {
      clip_id: clipId,
      storage_path: localPath,
      canonical_mime: "video/mp4",
      byte_size: videoBytes.byteLength,
      duration_seconds: durationSeconds,
      fps,
      width,
      height,
      sha256,
    },
  };
}

export function createVertexVeoVideoClient(
  options: VertexVeoVideoClientOptions,
): VeoVideoClient {
  let clientPromise: Promise<GoogleGenAIVideoClient> | null = null;
  const fetchBinary = options.fetchBinary ?? defaultFetchBinary;

  async function getClient(): Promise<GoogleGenAIVideoClient> {
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
    startSceneVideoGeneration: async (request) => {
      const client = await getClient();
      const generateRequest: Record<string, unknown> = {
        model: request.model,
        prompt: renderScenePrompt(request),
        config: {
          numberOfVideos: 1,
          durationSeconds: quantizeSceneDurationForVeo(request.scene.durationSeconds),
          aspectRatio: inferVeoAspectRatio(request.firstFrame.width, request.firstFrame.height),
          enhancePrompt: true,
          personGeneration: "ALLOW_ADULT",
          resolution: "1080p",
          generateAudio: true,
        },
      };

      if (isLocalFilePath(request.firstFrame.storagePath)) {
        const firstFrameBytes = await fs.readFile(
          request.firstFrame.storagePath,
        );
        generateRequest.image = {
          imageBytes: firstFrameBytes.toString("base64"),
          mimeType: request.firstFrame.canonicalMime,
        };
      }

      const operation = await client.models.generateVideos(generateRequest);
      const operationName = readOperationName(operation);
      if (!operationName) {
        throw new Error("vertex veo start did not return operation name");
      }

      return {
        provider_job_reference: operationName,
      };
    },
    getSceneVideoGenerationStatus: async (request) => {
      const client = await getClient();
      const operation = await client.operations.getVideosOperation({
        operation: createRestorableVideosOperation(request.providerJobReference),
      });

      return await parseOperationStatus(
        operation,
        request.providerJobReference,
        options.outputRootDir,
        fetchBinary,
      );
    },
  };
}

export type VeoVideoGeneratorOptions = {
  client: VeoVideoClient;
  model?: string;
  clock?: PollingClock;
};

export type VeoVideoGeneratorResult =
  | {
      outcome: "ok";
      providerRef: string | null;
      stageData: {
        video_generation: {
          prompt_metadata: {
            prompt_id: string;
            version: number;
            template_hash: string;
            model: string;
          };
          model_name: string;
          polling_policy: {
            schedule_seconds: [10, 20, 30];
            max_interval_seconds: 30;
            timeout_seconds: 900;
          };
          run_engine_attempt: number;
          derived_video_scenes: Array<{
            scene_id: string;
            source_asset_ids: string[];
            still_id: string;
            first_frame_storage_path: string;
            provider_job_reference: string;
            provider_latency_ms: number;
            poll_state: {
              poll_count: number;
              total_wait_ms: number;
              cadence_history_ms: number[];
              status_history: string[];
              timed_out: false;
            };
            clip: {
              clip_id: string;
              storage_path: string;
              canonical_mime: string;
              byte_size: number;
              duration_seconds: number;
              fps: number;
              width: number;
              height: number;
              sha256: string;
            };
          }>;
        };
      };
    }
  | {
      outcome: "policy_blocked" | "needs_clarification";
      reason: string;
      reasonCodes: FailureReasonCode[];
    }
  | {
      outcome: "retryable_error";
      reason: string;
      providerRef: string | null;
      details: Record<string, unknown>;
    }
  | {
      outcome: "provider_failed";
      reason: string;
      providerRef: string | null;
      details: Record<string, unknown>;
    };

function defaultClock(): PollingClock {
  return {
    now: () => Date.now(),
    sleep: async (ms) => {
      await new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    },
  };
}

export function createVeoVideoGenerator(options: VeoVideoGeneratorOptions): {
  generate: (
    payload: unknown,
    runId: string,
    runEngineAttempt: number,
  ) => Promise<VeoVideoGeneratorResult>;
} {
  const model = options.model ?? DEFAULT_MODEL;
  const clock = options.clock ?? defaultClock();
  const prompt = getPromptRegistryEntry(VEO_IMAGE_TO_VIDEO_PROMPT_ID);

  return {
    generate: async (payload, runId, runEngineAttempt) => {
      const parsedBrief = parseNormalizedBrief(
        isRecord(payload) && "normalized_brief" in payload
          ? payload.normalized_brief
          : payload,
      );
      if (!parsedBrief.ok) {
        return {
          outcome: "needs_clarification",
          reason:
            "normalized brief schema validation failed before video generation",
          reasonCodes: parsedBrief.reasonCodes,
        };
      }

      const stillsResult = readDerivedStills(payload);
      if (!stillsResult.ok) {
        return {
          outcome: "policy_blocked",
          reason:
            "video generation requires approved-asset-derived stills from image_generation",
          reasonCodes: stillsResult.reasonCodes,
        };
      }

      const stillBySceneId = new Map<string, Record<string, unknown>>();
      for (const still of stillsResult.stills) {
        if (typeof still.scene_id === "string") {
          stillBySceneId.set(still.scene_id, still);
        }
      }

      const promptMeta = promptMetadata(prompt, model);
      const scenes: Array<{
        scene_id: string;
        source_asset_ids: string[];
        still_id: string;
        first_frame_storage_path: string;
        provider_job_reference: string;
        provider_latency_ms: number;
        poll_state: {
          poll_count: number;
          total_wait_ms: number;
          cadence_history_ms: number[];
          status_history: string[];
          timed_out: false;
        };
        clip: {
          clip_id: string;
          storage_path: string;
          canonical_mime: string;
          byte_size: number;
          duration_seconds: number;
          fps: number;
          width: number;
          height: number;
          sha256: string;
        };
      }> = [];
      let latestProviderRef: string | null = null;

      for (const scene of parsedBrief.value.scenes) {
        if (scene.generationMode !== "asset_derived") {
          return {
            outcome: "policy_blocked",
            reason: `scene ${scene.sceneId} uses unsupported generationMode=${scene.generationMode}; video_generation requires first-frame asset-derived input`,
            reasonCodes: ["brand_critical_asset_required"],
          };
        }

        const still = stillBySceneId.get(scene.sceneId);
        if (!still) {
          return {
            outcome: "policy_blocked",
            reason: `derived still missing for scene ${scene.sceneId}`,
            reasonCodes: ["brand_critical_asset_required"],
          };
        }

        const stillId =
          typeof still.still_id === "string" ? still.still_id : null;
        const stillStoragePath =
          typeof still.storage_path === "string" ? still.storage_path : null;
        const stillMime =
          typeof still.canonical_mime === "string"
            ? still.canonical_mime
            : null;
        const stillWidth = typeof still.width === "number" ? still.width : null;
        const stillHeight =
          typeof still.height === "number" ? still.height : null;
        const stillSha = typeof still.sha256 === "string" ? still.sha256 : null;

        if (
          !stillId ||
          !stillStoragePath ||
          !stillMime ||
          stillWidth === null ||
          stillHeight === null ||
          !stillSha
        ) {
          return {
            outcome: "needs_clarification",
            reason: `derived still payload is incomplete for scene ${scene.sceneId}`,
            reasonCodes: ["brief_invalid_schema"],
          };
        }

        let providerJobReference: string;
        const sceneStartAtMs = clock.now();
        try {
          const startResponse = await options.client.startSceneVideoGeneration({
            runId,
            model,
            scene: {
              sceneId: scene.sceneId,
              sceneType: scene.sceneType,
              narrative: scene.narrative,
              durationSeconds: scene.durationSeconds,
            },
            prompt: {
              prompt_id: prompt.prompt_id,
              version: prompt.version,
              template_hash: prompt.template_hash,
              template: prompt.template,
            },
            firstFrame: {
              stillId,
              storagePath: stillStoragePath,
              canonicalMime: stillMime,
              width: stillWidth,
              height: stillHeight,
              sha256: stillSha,
            },
            sourceAssetIds: [...scene.approvedAssetIds],
          });

          providerJobReference = startResponse.provider_job_reference;
          latestProviderRef = providerJobReference;
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : `failed to start veo scene ${scene.sceneId}`;
          if (classifyTransientError(error)) {
            return {
              outcome: "retryable_error",
              reason: `veo transient start failure for scene ${scene.sceneId}: ${message}`,
              providerRef: latestProviderRef,
              details: {
                stage: "video_generation",
                scene_id: scene.sceneId,
                failure_type: "provider_transient_start",
              },
            };
          }

          return {
            outcome: "provider_failed",
            reason: `veo permanent start failure for scene ${scene.sceneId}: ${message}`,
            providerRef: latestProviderRef,
            details: {
              stage: "video_generation",
              scene_id: scene.sceneId,
              failure_type: "provider_start_failed",
            },
          };
        }

        const cadenceHistoryMs: number[] = [];
        const statusHistory: string[] = [];
        let pollCount = 0;
        let totalWaitMs = 0;

        while (clock.now() - sceneStartAtMs <= MAX_SCENE_WALL_CLOCK_MS) {
          let pollResponse: VeoSceneVideoStatusResponse;
          try {
            pollResponse = await options.client.getSceneVideoGenerationStatus({
              providerJobReference,
            });
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : `failed to poll veo scene ${scene.sceneId}`;
            if (classifyTransientError(error)) {
              return {
                outcome: "retryable_error",
                reason: `veo transient polling failure for scene ${scene.sceneId}: ${message}`,
                providerRef: providerJobReference,
                details: {
                  stage: "video_generation",
                  scene_id: scene.sceneId,
                  provider_job_reference: providerJobReference,
                  failure_type: "provider_transient_poll",
                  poll_count: pollCount,
                },
              };
            }

            return {
              outcome: "provider_failed",
              reason: `veo permanent polling failure for scene ${scene.sceneId}: ${message}`,
              providerRef: providerJobReference,
              details: {
                stage: "video_generation",
                scene_id: scene.sceneId,
                provider_job_reference: providerJobReference,
                failure_type: "provider_poll_failed",
                poll_count: pollCount,
              },
            };
          }

          pollCount += 1;
          statusHistory.push(pollResponse.status);

          if (pollResponse.status === "succeeded") {
            const providerLatency =
              typeof pollResponse.latencyMs === "number"
                ? pollResponse.latencyMs
                : Math.max(clock.now() - sceneStartAtMs, 0);

            scenes.push({
              scene_id: scene.sceneId,
              source_asset_ids: [...scene.approvedAssetIds],
              still_id: stillId,
              first_frame_storage_path: stillStoragePath,
              provider_job_reference: providerJobReference,
              provider_latency_ms: providerLatency,
              poll_state: {
                poll_count: pollCount,
                total_wait_ms: totalWaitMs,
                cadence_history_ms: cadenceHistoryMs,
                status_history: statusHistory,
                timed_out: false,
              },
              clip: pollResponse.clip,
            });
            break;
          }

          if (pollResponse.status === "failed") {
            if (pollResponse.retryable === true) {
              return {
                outcome: "retryable_error",
                reason: `veo transient provider failure for scene ${scene.sceneId}: ${pollResponse.reason}`,
                providerRef: providerJobReference,
                details: {
                  stage: "video_generation",
                  scene_id: scene.sceneId,
                  provider_job_reference: providerJobReference,
                  failure_type: "provider_transient_failed_status",
                  provider_reason: pollResponse.reason,
                  provider_reason_code: pollResponse.reasonCode ?? null,
                  poll_count: pollCount,
                },
              };
            }

            return {
              outcome: "provider_failed",
              reason: `veo provider failure for scene ${scene.sceneId}: ${pollResponse.reason}`,
              providerRef: providerJobReference,
              details: {
                stage: "video_generation",
                scene_id: scene.sceneId,
                provider_job_reference: providerJobReference,
                failure_type: "provider_failed_status",
                provider_reason: pollResponse.reason,
                provider_reason_code: pollResponse.reasonCode ?? null,
                poll_count: pollCount,
              },
            };
          }

          const delay = getPollingDelayMs(cadenceHistoryMs.length);
          cadenceHistoryMs.push(delay);
          totalWaitMs += delay;
          await clock.sleep(delay);
        }

        if (!scenes.some((entry) => entry.scene_id === scene.sceneId)) {
          return {
            outcome: "retryable_error",
            reason: `veo polling timed out for scene ${scene.sceneId} after ${MAX_SCENE_WALL_CLOCK_MS}ms`,
            providerRef: providerJobReference,
            details: {
              stage: "video_generation",
              scene_id: scene.sceneId,
              provider_job_reference: providerJobReference,
              failure_type: "provider_poll_timeout",
              max_wall_clock_ms: MAX_SCENE_WALL_CLOCK_MS,
              poll_count: pollCount,
              total_wait_ms: totalWaitMs,
              cadence_history_ms: cadenceHistoryMs,
              status_history: statusHistory,
            },
          };
        }
      }

      return {
        outcome: "ok",
        providerRef: scenes[0]?.provider_job_reference ?? null,
        stageData: {
          video_generation: {
            prompt_metadata: promptMeta,
            model_name: model,
            polling_policy: {
              schedule_seconds: [10, 20, 30],
              max_interval_seconds: 30,
              timeout_seconds: 900,
            },
            run_engine_attempt: runEngineAttempt,
            derived_video_scenes: scenes,
          },
        },
      };
    },
  };
}
