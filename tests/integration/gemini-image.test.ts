import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BRIEF_SCHEMA_VERSION,
  createGeminiImageStageHandler,
  createOpenAINormalizeStageHandler,
  createSQLiteRunEngine,
  createStageHandlers,
  type OpenAIResponsesRequest,
  type OpenAIResponsesResult,
  type StageHandler,
  type GeminiSceneStillRequest,
  type GeminiSceneStillResponse,
} from "@shared/index";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createFakeGeminiClient() {
  const requests: GeminiSceneStillRequest[] = [];

  return {
    requests,
    client: {
      generateSceneStill: async (request: GeminiSceneStillRequest): Promise<GeminiSceneStillResponse> => {
        requests.push(request);
        return {
          provider_job_reference: `vertex-job-${request.scene.sceneId}`,
          still: {
            still_id: `still-${request.scene.sceneId}`,
            storage_path: `mock://derived/${request.runId}/${request.scene.sceneId}.png`,
            canonical_mime: "image/png",
            byte_size: 2048,
            width: 1280,
            height: 720,
            sha256: `sha-${request.scene.sceneId}`,
          },
        };
      },
    },
  };
}

function createFakeOpenAIClient() {
  const requests: OpenAIResponsesRequest[] = [];

  return {
    requests,
    client: {
      createResponse: async (request: OpenAIResponsesRequest): Promise<OpenAIResponsesResult> => {
        requests.push(request);

        return {
          id: "resp-normalize-1",
          output_text: JSON.stringify({
            schemaVersion: BRIEF_SCHEMA_VERSION,
            briefId: "brief-from-openai",
            campaignName: "OpenAI Normalize Output",
            objective: "Drive awareness",
            language: "en",
            aspectRatio: "16:9",
            unresolvedQuestions: [],
            scenes: [
              {
                sceneId: "scene-intro",
                sceneType: "intro",
                visualCriticality: "supporting",
                narrative: "Intro stage from normalized output",
                desiredTags: ["logo", "background"],
                approvedAssetIds: [],
                generationMode: "asset_derived",
                requestedTransform: "overlay",
                durationSeconds: 5,
              },
              {
                sceneId: "scene-product",
                sceneType: "product_focus",
                visualCriticality: "brand_critical",
                narrative: "Product stage from normalized output",
                desiredTags: ["product", "packshot"],
                approvedAssetIds: [],
                generationMode: "asset_derived",
                requestedTransform: "crop",
                durationSeconds: 6,
              },
            ],
          }),
        };
      },
    },
  };
}

const validatePolicyStageForTest: StageHandler = async (context) => {
  const payload = context.payload as { normalized_brief?: Record<string, unknown> };
  const normalizedBrief = payload.normalized_brief as
    | {
        scenes?: Array<{ sceneId: string; sceneType: string; approvedAssetIds: string[] }>;
      }
    | undefined;

  if (!normalizedBrief || !Array.isArray(normalizedBrief.scenes)) {
    return {
      type: "terminal_outcome",
      outcome: "needs_clarification",
      reason: "normalized_brief missing before validate_policy stage",
    };
  }

  const enrichedScenes = normalizedBrief.scenes.map((scene) => {
    if (scene.sceneType === "intro") {
      return {
        ...scene,
        approvedAssetIds: ["brand-wordmark-primary", "studio-gradient-backdrop"],
      };
    }

    return {
      ...scene,
      approvedAssetIds: ["product-can-classic-packshot"],
    };
  });

  return {
    type: "success",
    data: {
      validate_policy: {
        selected_asset_ids: [
          "brand-wordmark-primary",
          "studio-gradient-backdrop",
          "product-can-classic-packshot",
        ],
      },
      normalized_brief: {
        ...normalizedBrief,
        scenes: enrichedScenes,
      },
    },
  };
};

function createPayloadWithApprovedAssets() {
  return {
    normalized_brief: {
      schemaVersion: BRIEF_SCHEMA_VERSION,
      briefId: "brief-gemini-1",
      campaignName: "Gemini Approved Assets",
      objective: "Create one still per scene",
      language: "en",
      aspectRatio: "16:9",
      unresolvedQuestions: [],
      scenes: [
        {
          sceneId: "scene-intro",
          sceneType: "intro",
          visualCriticality: "supporting",
          narrative: "Logo reveal on gradient backdrop",
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
          narrative: "Packshot hero with controlled crop",
          desiredTags: ["product", "packshot"],
          approvedAssetIds: ["product-can-classic-packshot"],
          generationMode: "asset_derived",
          requestedTransform: "crop",
          durationSeconds: 6,
        },
      ],
    },
  };
}

describe("gemini-image", () => {
  test("normalize -> image_generation chain succeeds with propagated normalized output", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deal-pump-gemini-image-"));
    const sqlitePath = path.join(tempRoot, "deal-pump.sqlite");
    const fakeOpenAI = createFakeOpenAIClient();
    const fake = createFakeGeminiClient();
    const normalizeStage = createOpenAINormalizeStageHandler({
      client: fakeOpenAI.client,
      model: "gpt-5.4-mini",
    });
    const imageStage = createGeminiImageStageHandler({
      client: fake.client,
      approvedAssetsRootDir: path.resolve(process.cwd(), "public/assets/approved"),
      model: "gemini-2.5-flash-image",
    });

    const engine = await createSQLiteRunEngine({
      sqlitePath,
      leaseDurationMs: 250,
      retryBackoffBaseMs: 10,
    });
    await engine.initialize();

    const handlers = createStageHandlers({
      normalize: normalizeStage,
      validatePolicy: validatePolicyStageForTest,
      imageGeneration: imageStage,
    });
    const started = await engine.startRun({
      idempotencyKey: "gemini-image-happy-path",
      payload: {
        brief: "Launch a product ad with intro and product focus scenes.",
      },
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
    expect(fakeOpenAI.requests).toHaveLength(1);
    expect(fake.requests).toHaveLength(2);

    const imageEvent = projection.events.find(
      (event) =>
        event.eventType === "job_succeeded" &&
        typeof event.payload.stage === "string" &&
        event.payload.stage === "image_generation",
    );
    expect(imageEvent).toBeDefined();
    expect(imageEvent?.payload.stage_output).toMatchObject({
      image_generation: {
        model_name: "gemini-2.5-flash-image",
        prompt_metadata: {
          prompt_id: "generate_scene_still_gemini_2_5_flash_image",
          version: 1,
          template_hash: "04e43e2f8fde321f77ceb4479f57ccf6a6d98b9979491ef4f71673cc7d9012cb",
          model: "gemini-2.5-flash-image",
        },
        source_asset_ids: [
          "brand-wordmark-primary",
          "studio-gradient-backdrop",
          "product-can-classic-packshot",
        ],
      },
    });

    const stageOutput = imageEvent?.payload.stage_output as {
      image_generation: {
        derived_stills: Array<{ scene_id: string; provider_job_reference: string }>;
      };
    };
    expect(stageOutput.image_generation.derived_stills).toHaveLength(2);
    expect(stageOutput.image_generation.derived_stills[0]?.provider_job_reference).toBe("vertex-job-scene-intro");

    await engine.close();
  });

  test("rejects missing approved asset IDs before provider call", async () => {
    const fake = createFakeGeminiClient();
    const imageStage = createGeminiImageStageHandler({
      client: fake.client,
      approvedAssetsRootDir: path.resolve(process.cwd(), "public/assets/approved"),
    });

    const result = await imageStage({
      runId: "run-missing-assets",
      stage: "image_generation",
      attemptCount: 1,
      payload: {
        normalized_brief: {
          schemaVersion: BRIEF_SCHEMA_VERSION,
          briefId: "brief-missing-assets",
          campaignName: "Missing Assets",
          objective: "Should fail fast",
          language: "en",
          aspectRatio: "16:9",
          unresolvedQuestions: [],
          scenes: [
            {
              sceneId: "scene-1",
              sceneType: "intro",
              visualCriticality: "supporting",
              narrative: "No approved assets are supplied",
              desiredTags: ["background"],
              approvedAssetIds: [],
              generationMode: "asset_derived",
              requestedTransform: "overlay",
              durationSeconds: 4,
            },
          ],
        },
      },
    });

    expect(result.type).toBe("terminal_outcome");
    if (result.type !== "terminal_outcome") {
      return;
    }

    expect(result.outcome).toBe("policy_blocked");
    expect(result.reason).toContain("brief_no_asset_match");
    expect(fake.requests).toHaveLength(0);
  });

  test("rejects remote URL and integrity mismatch before provider call", async () => {
    const fake = createFakeGeminiClient();

    const remoteUrlStage = createGeminiImageStageHandler({
      client: fake.client,
      approvedAssetsRootDir: path.resolve(process.cwd(), "public/assets/approved"),
    });

    const remoteUrlResult = await remoteUrlStage({
      runId: "run-remote-url",
      stage: "image_generation",
      attemptCount: 1,
      payload: {
        normalized_brief: {
          schemaVersion: BRIEF_SCHEMA_VERSION,
          briefId: "brief-remote-url",
          campaignName: "Remote URL",
          objective: "Should fail before provider",
          language: "en",
          aspectRatio: "16:9",
          unresolvedQuestions: [],
          scenes: [
            {
              sceneId: "scene-1",
              sceneType: "intro",
              visualCriticality: "brand_critical",
              narrative: "Do not fetch external URLs",
              desiredTags: ["logo"],
              approvedAssetIds: ["https://example.com/remote-logo.png"],
              generationMode: "asset_derived",
              requestedTransform: "overlay",
              durationSeconds: 4,
            },
          ],
        },
      },
    });

    expect(remoteUrlResult.type).toBe("terminal_outcome");
    if (remoteUrlResult.type !== "terminal_outcome") {
      return;
    }

    expect(remoteUrlResult.reason).toContain("external_asset_source_forbidden");
    expect(fake.requests).toHaveLength(0);

    const integrityStage = createGeminiImageStageHandler({
      client: fake.client,
      approvedAssetsRootDir: path.resolve(process.cwd(), "public/assets/approved-missing"),
    });
    const integrityResult = await integrityStage({
      runId: "run-integrity-fail",
      stage: "image_generation",
      attemptCount: 1,
      payload: createPayloadWithApprovedAssets(),
    });

    expect(integrityResult.type).toBe("terminal_outcome");
    if (integrityResult.type !== "terminal_outcome") {
      return;
    }

    expect(integrityResult.reason).toContain("approved_asset_missing_on_disk");
    expect(fake.requests).toHaveLength(0);
  });

  test("surfaces provider adapter exceptions as fatal stage errors", async () => {
    const stage = createGeminiImageStageHandler({
      client: {
        generateSceneStill: async () => {
          throw new Error("vertex image adapter decode failure");
        },
      },
      approvedAssetsRootDir: path.resolve(process.cwd(), "public/assets/approved"),
    });

    const result = await stage({
      runId: "run-gemini-provider-fail",
      stage: "image_generation",
      attemptCount: 1,
      payload: createPayloadWithApprovedAssets(),
    });

    expect(result.type).toBe("fatal_error");
    if (result.type !== "fatal_error") {
      return;
    }

    expect(result.reason).toContain("vertex image adapter decode failure");
  });
});
