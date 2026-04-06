import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BRIEF_SCHEMA_VERSION,
  createPreGeneratedImageStageHandler,
  createSQLiteRunEngine,
  createStageHandlers,
  createVeoVideoStageHandler,
  type StageHandler,
  type VeoSceneVideoStartRequest,
  type VeoSceneVideoStatusRequest,
  type VeoSceneVideoStatusResponse,
} from "@shared/index";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type TestScene = {
  sceneId: string;
  sceneType: "intro" | "product_focus";
  visualCriticality: "supporting" | "brand_critical";
  narrative: string;
  desiredTags: string[];
  approvedAssetIds: string[];
  generationMode: "asset_derived";
  requestedTransform: "overlay" | "crop";
  durationSeconds: number;
};

function createNormalizedBrief(scenes: TestScene[]) {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    briefId: "brief-veo-1",
    campaignName: "Veo Adapter Integration",
    objective: "Animate derived stills into clips",
    language: "en",
    aspectRatio: "4:9",
    unresolvedQuestions: [],
    scenes,
  };
}

function createAdvancingClock() {
  let nowMs = 0;
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      nowMs += ms;
    },
  };
}

function createHappyVeoClient() {
  const startRequests: VeoSceneVideoStartRequest[] = [];
  const statusRequests: VeoSceneVideoStatusRequest[] = [];
  const pollCounter = new Map<string, number>();

  return {
    startRequests,
    statusRequests,
    client: {
      startSceneVideoGeneration: async (request: VeoSceneVideoStartRequest) => {
        startRequests.push(request);
        return {
          provider_job_reference: `vertex-veo-${request.scene.sceneId}`,
        };
      },
      getSceneVideoGenerationStatus: async (
        request: VeoSceneVideoStatusRequest,
      ): Promise<VeoSceneVideoStatusResponse> => {
        statusRequests.push(request);
        const current = (pollCounter.get(request.providerJobReference) ?? 0) + 1;
        pollCounter.set(request.providerJobReference, current);

        if (current < 3) {
          return {
            status: "in_progress",
            progressPercent: current * 40,
          };
        }

        const sceneId = request.providerJobReference.replace("vertex-veo-", "");
        return {
          status: "succeeded",
          latencyMs: 36_000,
          clip: {
            clip_id: `clip-${sceneId}`,
            storage_path: `mock://video/${sceneId}.mp4`,
            canonical_mime: "video/mp4",
            byte_size: 4096,
            duration_seconds: 5,
            fps: 24,
            width: 1280,
            height: 720,
            sha256: `video-sha-${sceneId}`,
          },
        };
      },
    },
  };
}

describe("veo-adapter", () => {
  test("video_generation stage animates derived stills with fixed polling cadence metadata", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deal-pump-veo-adapter-"));
    const sqlitePath = path.join(tempRoot, "deal-pump.sqlite");

    const normalizeStage: StageHandler = async () => {
      return {
        type: "success",
        data: {
          normalize: {
            prompt_metadata: [],
            repair_attempted: false,
            sanitized_brief: "sanitized",
            normalized_brief: createNormalizedBrief([
              {
                sceneId: "scene-intro",
                sceneType: "intro",
                visualCriticality: "supporting",
                narrative: "Spokeswoman hook",
                desiredTags: ["hero", "social"],
                approvedAssetIds: ["hook-spokeswoman-dealpump"],
                generationMode: "asset_derived",
                requestedTransform: "overlay",
                durationSeconds: 5,
              },
              {
                sceneId: "scene-product",
                sceneType: "product_focus",
                visualCriticality: "brand_critical",
                narrative: "Product demo close-up",
                desiredTags: ["product", "packshot"],
                approvedAssetIds: ["product-demo-closeup"],
                generationMode: "asset_derived",
                requestedTransform: "crop",
                durationSeconds: 5,
              },
            ]),
            reason_codes: [],
          },
          normalized_brief: createNormalizedBrief([
            {
              sceneId: "scene-intro",
              sceneType: "intro",
              visualCriticality: "supporting",
              narrative: "Spokeswoman hook",
              desiredTags: ["hero", "social"],
              approvedAssetIds: ["hook-spokeswoman-dealpump"],
              generationMode: "asset_derived",
              requestedTransform: "overlay",
              durationSeconds: 5,
            },
            {
              sceneId: "scene-product",
              sceneType: "product_focus",
              visualCriticality: "brand_critical",
              narrative: "Product demo close-up",
              desiredTags: ["product", "packshot"],
              approvedAssetIds: ["product-demo-closeup"],
              generationMode: "asset_derived",
              requestedTransform: "crop",
              durationSeconds: 5,
            },
          ]),
        },
      };
    };

    const validatePolicyStage: StageHandler = async (context) => {
      const payload = context.payload as { normalized_brief: unknown };
      return {
        type: "success",
        data: {
          validate_policy: {
            selected_asset_ids: [
              "hook-spokeswoman-dealpump",
              "product-demo-closeup",
            ],
          },
          normalized_brief: payload.normalized_brief,
        },
      };
    };

    const assetsRoot = path.join(tempRoot, "approved-assets");
    await fs.mkdir(assetsRoot, { recursive: true });
    await fs.writeFile(path.join(assetsRoot, "01-hook-spokeswoman-dealpump.png"), Buffer.from("intro-image"));
    await fs.writeFile(path.join(assetsRoot, "02-product-demo-closeup.png"), Buffer.from("product-image"));

    const imageStage = createPreGeneratedImageStageHandler({
      assetsRootDir: assetsRoot,
      model: "pre_generated_assets",
    });

    const fakeVeo = createHappyVeoClient();
    const veoStage = createVeoVideoStageHandler({
      client: fakeVeo.client,
      model: "veo-3.1-generate-preview",
      clock: createAdvancingClock(),
    });

    const engine = await createSQLiteRunEngine({
      sqlitePath,
      leaseDurationMs: 250,
      retryBackoffBaseMs: 10,
    });
    await engine.initialize();

    const handlers = createStageHandlers({
      normalize: normalizeStage,
      validatePolicy: validatePolicyStage,
      imageGeneration: imageStage,
      videoGeneration: veoStage,
    });

    const started = await engine.startRun({
      idempotencyKey: "veo-adapter-happy-path",
      payload: { brief: "Generate animated clips for each approved-asset-derived scene." },
    });

    for (let index = 0; index < 120; index += 1) {
      const claim = await engine.claimNextJob();
      if (!claim) {
        await sleep(10);
        continue;
      }

      await engine.processClaim(claim, handlers);
      const projection = await engine.getRunProjection(started.runId);
      if (projection.phase === "completed") {
        break;
      }
    }

    const projection = await engine.getRunProjection(started.runId);
    expect(projection.phase).toBe("completed");
    expect(fakeVeo.startRequests).toHaveLength(2);
    expect(fakeVeo.startRequests[0]?.firstFrame.storagePath).toContain("01-hook-spokeswoman-dealpump.png");

    const videoEvent = projection.events.find(
      (event) =>
        event.eventType === "job_succeeded" &&
        typeof event.payload.stage === "string" &&
        event.payload.stage === "video_generation",
    );
    expect(videoEvent).toBeDefined();
    expect(videoEvent?.payload.provider_ref).toBe("vertex-veo-scene-intro");

    const stageOutput = videoEvent?.payload.stage_output as {
      video_generation: {
        polling_policy: {
          schedule_seconds: number[];
          max_interval_seconds: number;
          timeout_seconds: number;
        };
        derived_video_scenes: Array<{
          scene_id: string;
          provider_job_reference: string;
          provider_latency_ms: number;
          poll_state: {
            cadence_history_ms: number[];
          };
        }>;
      };
    };
    expect(stageOutput.video_generation.polling_policy).toEqual({
      schedule_seconds: [10, 20, 30],
      max_interval_seconds: 30,
      timeout_seconds: 900,
    });
    expect(stageOutput.video_generation.derived_video_scenes).toHaveLength(2);
    expect(stageOutput.video_generation.derived_video_scenes[0]?.provider_job_reference).toBe(
      "vertex-veo-scene-intro",
    );
    expect(stageOutput.video_generation.derived_video_scenes[0]?.provider_latency_ms).toBe(36_000);
    expect(stageOutput.video_generation.derived_video_scenes[0]?.poll_state.cadence_history_ms).toEqual([
      10_000,
      20_000,
    ]);

    await engine.close();
  });

  test("timeouts surface provider_failed after run-engine retries exhaust", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deal-pump-veo-timeout-"));
    const sqlitePath = path.join(tempRoot, "deal-pump.sqlite");

    const normalizedBrief = createNormalizedBrief([
      {
        sceneId: "scene-timeout",
        sceneType: "intro",
        visualCriticality: "brand_critical",
        narrative: "Scene that never completes",
        desiredTags: ["hero"],
        approvedAssetIds: ["hook-spokeswoman-dealpump"],
        generationMode: "asset_derived",
        requestedTransform: "overlay",
        durationSeconds: 5,
      },
    ]);

    const normalizeStage: StageHandler = async () => {
      return {
        type: "success",
        data: {
          normalize: {
            prompt_metadata: [],
            repair_attempted: false,
            sanitized_brief: "sanitized",
            normalized_brief: normalizedBrief,
            reason_codes: [],
          },
          normalized_brief: normalizedBrief,
        },
      };
    };

    const validatePolicyStage: StageHandler = async () => {
      return {
        type: "success",
        data: {
          validate_policy: {
            selected_asset_ids: ["hook-spokeswoman-dealpump"],
          },
          normalized_brief: normalizedBrief,
        },
      };
    };

    const imageStage: StageHandler = async () => {
      return {
        type: "success",
        data: {
          image_generation: {
            prompt_metadata: {
              prompt_id: "generate_scene_still_gemini_2_5_flash_image",
              version: 1,
              template_hash: "hash",
              model: "gemini-2.5-flash-image",
            },
            model_name: "gemini-2.5-flash-image",
            source_asset_ids: ["hook-spokeswoman-dealpump"],
            derived_stills: [
              {
                scene_id: "scene-timeout",
                source_asset_ids: ["hook-spokeswoman-dealpump"],
                provider_job_reference: "vertex-image-scene-timeout",
                still_id: "still-scene-timeout",
                storage_path: "/tmp/scene-timeout.png",
                canonical_mime: "image/png",
                byte_size: 1024,
                width: 1080,
                height: 2430,
                sha256: "sha-timeout",
              },
            ],
          },
        },
      };
    };

    const startRequests: VeoSceneVideoStartRequest[] = [];
    const statusRequests: VeoSceneVideoStatusRequest[] = [];
    const timeoutVeoStage = createVeoVideoStageHandler({
      model: "veo-3.1-generate-preview",
      clock: createAdvancingClock(),
      client: {
        startSceneVideoGeneration: async (request) => {
          startRequests.push(request);
          return {
            provider_job_reference: "vertex-veo-timeout",
          };
        },
        getSceneVideoGenerationStatus: async (request) => {
          statusRequests.push(request);
          return {
            status: "queued",
          };
        },
      },
    });

    const engine = await createSQLiteRunEngine({
      sqlitePath,
      leaseDurationMs: 250,
      retryBackoffBaseMs: 5,
      maxAttemptsPerStage: 2,
    });
    await engine.initialize();

    const handlers = createStageHandlers({
      normalize: normalizeStage,
      validatePolicy: validatePolicyStage,
      imageGeneration: imageStage,
      videoGeneration: timeoutVeoStage,
    });

    const started = await engine.startRun({
      idempotencyKey: "veo-timeout-retries",
      payload: {
        brief: "Scene should timeout and exercise retry flow.",
      },
    });

    for (let index = 0; index < 160; index += 1) {
      const claim = await engine.claimNextJob();
      if (!claim) {
        await sleep(10);
        continue;
      }

      await engine.processClaim(claim, handlers);
      const projection = await engine.getRunProjection(started.runId);
      if (projection.phase === "failed") {
        break;
      }
    }

    const projection = await engine.getRunProjection(started.runId);
    expect(projection.phase).toBe("failed");
    expect(projection.outcome).toBe("provider_failed");
    expect(String(projection.result?.reason)).toContain("timed out");
    expect(startRequests.length).toBe(2);
    expect(statusRequests.length).toBeGreaterThan(2);

    const videoJob = projection.provenance.providerJobs.find((job) => job.stage === "video_generation");
    expect(videoJob?.attemptCount).toBe(2);
    expect(videoJob?.status).toBe("failed");
    expect(videoJob?.providerRef).toBe("vertex-veo-timeout");
    expect(videoJob?.lastError).toContain("timed out");

    const retryEvents = projection.events.filter((event) => event.eventType === "job_retry_scheduled");
    expect(retryEvents.length).toBeGreaterThanOrEqual(1);
    expect(retryEvents[0]?.payload.stage).toBe("video_generation");
    expect(retryEvents[0]?.payload.provider_ref).toBe("vertex-veo-timeout");

    await engine.close();
  });
});
