import { parseNormalizedBrief } from "./brief-schema";
import type { FailureReasonCode } from "./contracts";
import {
  getPromptRegistryEntry,
  VEO_IMAGE_TO_VIDEO_PROMPT_ID,
  type PromptRegistryEntry,
} from "./prompt-registry";

const DEFAULT_MODEL = "veo-3.1-generate-preview";
const POLLING_SCHEDULE_MS = [10_000, 20_000, 30_000] as const;
const MAX_POLL_INTERVAL_MS = 30_000;
const MAX_SCENE_WALL_CLOCK_MS = 15 * 60 * 1_000;

type PollingClock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDerivedStills(payload: unknown):
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
    stills: stills.filter((entry): entry is Record<string, unknown> => isRecord(entry)),
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
  startSceneVideoGeneration: (request: VeoSceneVideoStartRequest) => Promise<{ provider_job_reference: string }>;
  getSceneVideoGenerationStatus: (
    request: VeoSceneVideoStatusRequest,
  ) => Promise<VeoSceneVideoStatusResponse>;
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
  generate: (payload: unknown, runId: string, runEngineAttempt: number) => Promise<VeoVideoGeneratorResult>;
} {
  const model = options.model ?? DEFAULT_MODEL;
  const clock = options.clock ?? defaultClock();
  const prompt = getPromptRegistryEntry(VEO_IMAGE_TO_VIDEO_PROMPT_ID);

  return {
    generate: async (payload, runId, runEngineAttempt) => {
      const parsedBrief = parseNormalizedBrief(
        isRecord(payload) && "normalized_brief" in payload ? payload.normalized_brief : payload,
      );
      if (!parsedBrief.ok) {
        return {
          outcome: "needs_clarification",
          reason: "normalized brief schema validation failed before video generation",
          reasonCodes: parsedBrief.reasonCodes,
        };
      }

      const stillsResult = readDerivedStills(payload);
      if (!stillsResult.ok) {
        return {
          outcome: "policy_blocked",
          reason: "video generation requires approved-asset-derived stills from image_generation",
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

        const stillId = typeof still.still_id === "string" ? still.still_id : null;
        const stillStoragePath = typeof still.storage_path === "string" ? still.storage_path : null;
        const stillMime = typeof still.canonical_mime === "string" ? still.canonical_mime : null;
        const stillWidth = typeof still.width === "number" ? still.width : null;
        const stillHeight = typeof still.height === "number" ? still.height : null;
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
          const message = error instanceof Error ? error.message : `failed to start veo scene ${scene.sceneId}`;
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
            const message = error instanceof Error ? error.message : `failed to poll veo scene ${scene.sceneId}`;
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
