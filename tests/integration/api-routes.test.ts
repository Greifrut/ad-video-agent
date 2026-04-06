import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  computeArtifactRouteSignature,
  createOpenAINormalizeStageHandler,
  createPreGeneratedImageStageHandler,
  createRuntimeValidatePolicyStageHandler,
  createSQLiteRunEngine,
  createStageHandlers,
  createSubtitlesExportStageHandler,
  createVeoVideoStageHandler,
  parseNormalizedBrief,
  type MediaCommandRunner,
  type OpenAIResponsesClient,
  type RunPhase,
  type StageHandler,
  type VeoVideoClient,
} from "@shared/index";
import { resetRateLimitersForTests } from "@/app/api/_server/rate-limit";
import { resetRunEngineForTests } from "@/app/api/_server/run-engine-instance";
import { POST as startRunRoute } from "@/app/api/v1/runs/route";
import { GET as getRunStatusRoute } from "@/app/api/v1/runs/[runId]/route";
import { GET as getArtifactRoute } from "@/app/api/v1/runs/[runId]/artifacts/[artifactName]/route";
import blockedBriefFixture from "../unit/fixtures/briefs/policy-blocked-brief.json";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createMockMediaRunner(): MediaCommandRunner {
  const metadataByPath = new Map<string, { width: number; height: number; codec: string; fps: number; duration: number }>();

  return async (command, args) => {
    const outputPath = args[args.length - 1] ?? "";

    if (command === "ffmpeg") {
      if (outputPath) {
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, Buffer.from(`video:${path.basename(outputPath)}`));

        const durationFromLavfi = args.find((value) => value.includes("color=") && value.includes(":d="));
        const durationMatch = durationFromLavfi?.match(/:d=([0-9.]+)/);
        const duration = durationMatch ? Number.parseFloat(durationMatch[1] ?? "2") : 2;
        metadataByPath.set(outputPath, {
          width: 1080,
          height: 2430,
          codec: "h264",
          fps: 24,
          duration: Number.isFinite(duration) ? duration : 2,
        });
      }

      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    }

    const inputPath = outputPath;
    const metadata = metadataByPath.get(inputPath) ?? {
      width: 1080,
      height: 2430,
      codec: "h264",
      fps: 24,
      duration: 5,
    };

    return {
      exitCode: 0,
      stdout: JSON.stringify({
        streams: [
          {
            codec_type: "video",
            codec_name: metadata.codec,
            width: metadata.width,
            height: metadata.height,
            avg_frame_rate: `${metadata.fps}/1`,
            duration: String(metadata.duration),
          },
        ],
        format: { duration: String(metadata.duration) },
      }),
      stderr: "",
    };
  };
}

function createFixtureOpenAIClient(): OpenAIResponsesClient {
  return {
    createResponse: async () => {
      return {
        id: "fixture-openai-1",
        output_text: JSON.stringify({
          schemaVersion: "1.0.0",
          briefId: "fixture-brief-1",
          campaignName: "Fixture Campaign",
          objective: "Create a simple fixture ad",
          language: "en",
          aspectRatio: "16:9",
          unresolvedQuestions: [],
          scenes: [
            {
              sceneId: "scene-intro",
              sceneType: "intro",
              visualCriticality: "supporting",
              narrative: "Intro with logo and background",
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
              narrative: "Product hero moment",
              desiredTags: ["product", "packshot"],
              approvedAssetIds: [],
              generationMode: "asset_derived",
              requestedTransform: "animate",
              durationSeconds: 6,
            },
          ],
        }),
      };
    },
  };
}

function createFixtureVeoClient(): VeoVideoClient {
  return {
    startSceneVideoGeneration: async (request) => {
      return {
        provider_job_reference: `fixture-veo-${request.scene.sceneId}`,
      };
    },
    getSceneVideoGenerationStatus: async (request) => {
      const sceneId = request.providerJobReference.replace("fixture-veo-", "");
      return {
        status: "succeeded",
        latencyMs: 300,
        clip: {
          clip_id: `clip-${sceneId}`,
          storage_path: `mock://video/${sceneId}.mp4`,
          canonical_mime: "video/mp4",
          byte_size: 2048,
          duration_seconds: 5,
          fps: 24,
          width: 1280,
          height: 720,
          sha256: `video-sha-${sceneId}`,
        },
      };
    },
  };
}

async function createIsolatedEnvironment(options?: { createDirs?: boolean }) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deal-pump-api-routes-"));
  const dataDir = path.join(tempRoot, "data");
  const artifactsDir = path.join(dataDir, "artifacts");
  const sqlitePath = path.join(dataDir, "deal-pump.sqlite");
  if (options?.createDirs !== false) {
    await fs.mkdir(artifactsDir, { recursive: true });
  }

  Object.assign(process.env, {
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    ARTIFACTS_DIR: artifactsDir,
    SQLITE_DB_PATH: sqlitePath,
    WORKER_CONCURRENCY: "1",
  });

  return {
    tempRoot,
    dataDir,
    artifactsDir,
    sqlitePath,
  };
}

async function processRunUntil(
  sqlitePath: string,
  runId: string,
  handlers: ReturnType<typeof createStageHandlers>,
  targetPhase: RunPhase,
): Promise<void> {
  const engine = await createSQLiteRunEngine({
    sqlitePath,
    leaseDurationMs: 200,
    retryBackoffBaseMs: 5,
  });
  await engine.initialize();

  for (let index = 0; index < 120; index += 1) {
    const claim = await engine.claimNextJob();
    if (!claim) {
      await sleep(10);
      const current = await engine.getRunProjection(runId);
      if (current.phase === targetPhase) {
        break;
      }
      continue;
    }

    await engine.processClaim(claim, handlers);
    const projection = await engine.getRunProjection(runId);
    if (projection.phase === targetPhase) {
      break;
    }
  }

  await engine.close();
}

describe("api-routes", () => {
  beforeEach(async () => {
    resetRateLimitersForTests();
    await resetRunEngineForTests();
  });

  afterEach(async () => {
    resetRateLimitersForTests();
    await resetRunEngineForTests();
  });

  test("start route requires Idempotency-Key and reuses run ID on duplicate key", async () => {
    await createIsolatedEnvironment();

    const missingIdempotencyRequest = new NextRequest("http://localhost/api/v1/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.9",
      },
      body: JSON.stringify({ brief: "missing header" }),
    });

    const missingResponse = await startRunRoute(missingIdempotencyRequest);
    expect(missingResponse.status).toBe(400);

    const firstRequest = new NextRequest("http://localhost/api/v1/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "dup-key-1",
        "x-forwarded-for": "198.51.100.9",
      },
      body: JSON.stringify({ brief: "Generate fixture ad", fixtureMode: true }),
    });
    const firstResponse = await startRunRoute(firstRequest);
    expect(firstResponse.status).toBe(202);
    const firstBody = (await firstResponse.json()) as { runId: string };
    expect(firstBody.runId).toBeTruthy();

    const duplicateRequest = new NextRequest("http://localhost/api/v1/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "dup-key-1",
        "x-forwarded-for": "198.51.100.9",
      },
      body: JSON.stringify({ brief: "Generate fixture ad", fixtureMode: true }),
    });
    const duplicateResponse = await startRunRoute(duplicateRequest);
    expect(duplicateResponse.status).toBe(200);
    const duplicateBody = (await duplicateResponse.json()) as { runId: string };
    expect(duplicateBody.runId).toBe(firstBody.runId);
  });

  test("start route rejects malformed body and enforces start rate limits", async () => {
    await createIsolatedEnvironment();

    const malformedBodyRequest = new NextRequest("http://localhost/api/v1/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "malformed-1",
        "x-forwarded-for": "203.0.113.10",
      },
      body: JSON.stringify({ brief: 42 }),
    });

    const malformedResponse = await startRunRoute(malformedBodyRequest);
    expect(malformedResponse.status).toBe(400);

    for (let index = 0; index < 5; index += 1) {
      const request = new NextRequest("http://localhost/api/v1/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `rate-start-${index}`,
          "x-forwarded-for": "203.0.113.20",
        },
        body: JSON.stringify({ brief: `Rate limit start ${index}` }),
      });
      const response = await startRunRoute(request);
      expect(response.status).toBe(202);
    }

    const blockedRequest = new NextRequest("http://localhost/api/v1/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "rate-start-blocked",
        "x-forwarded-for": "203.0.113.20",
      },
      body: JSON.stringify({ brief: "Rate limit blocked" }),
    });
    const blockedResponse = await startRunRoute(blockedRequest);
    expect(blockedResponse.status).toBe(429);
    expect(blockedResponse.headers.get("retry-after")).toBeTruthy();
  });

  test("status route returns policy_blocked payload and enforces status rate limit", async () => {
    const env = await createIsolatedEnvironment();

    const parsedBlocked = parseNormalizedBrief(blockedBriefFixture);
    expect(parsedBlocked.ok).toBe(true);
    if (!parsedBlocked.ok) {
      throw new Error("Blocked brief fixture must parse.");
    }

    const setupEngine = await createSQLiteRunEngine({ sqlitePath: env.sqlitePath, leaseDurationMs: 200 });
    await setupEngine.initialize();
    const started = await setupEngine.startRun({
      idempotencyKey: "blocked-run",
      payload: {
        brief: "blocked",
        fixture_mode: true,
      },
    });
    await setupEngine.close();

    const normalizeStage: StageHandler = async () => {
      return {
        type: "success",
        data: {
          normalize: {
            prompt_metadata: [],
            repair_attempted: false,
            sanitized_brief: "sanitized",
            normalized_brief: parsedBlocked.value,
            reason_codes: [],
          },
          normalized_brief: parsedBlocked.value,
        },
      };
    };
    const validatePolicyStage: StageHandler = async () => {
      return {
        type: "terminal_outcome",
        outcome: "policy_blocked",
        reason: "Invented brand-critical media is blocked.",
        data: {
          validate_policy: {
            reason_codes: ["invented_brand_critical_media", "brand_critical_asset_required"],
          },
          normalized_brief: parsedBlocked.value,
        },
      };
    };

    await processRunUntil(
      env.sqlitePath,
      started.runId,
      createStageHandlers({
        normalize: normalizeStage,
        validatePolicy: validatePolicyStage,
      }),
      "failed",
    );

    const statusResponse = await getRunStatusRoute(
      new NextRequest(`http://localhost/api/v1/runs/${started.runId}`, {
        method: "GET",
        headers: {
          "x-forwarded-for": "192.0.2.100",
        },
      }),
      {
        params: Promise.resolve({ runId: started.runId }),
      },
    );
    expect(statusResponse.status).toBe(200);

    const statusPayload = (await statusResponse.json()) as {
      runId: string;
      phase: string;
      outcome: string;
      errorCode?: string;
      normalizedBrief?: unknown;
    };

    expect(statusPayload.runId).toBe(started.runId);
    expect(statusPayload.phase).toBe("failed");
    expect(statusPayload.outcome).toBe("policy_blocked");
    expect(statusPayload.errorCode).toBe("invented_brand_critical_media");
    expect(statusPayload.normalizedBrief).toBeDefined();

    for (let index = 0; index < 60; index += 1) {
      const response = await getRunStatusRoute(
        new NextRequest(`http://localhost/api/v1/runs/${started.runId}`, {
          method: "GET",
          headers: {
            "x-forwarded-for": "192.0.2.120",
          },
        }),
        {
          params: Promise.resolve({ runId: started.runId }),
        },
      );
      expect(response.status).toBe(200);
    }

    const limitedResponse = await getRunStatusRoute(
      new NextRequest(`http://localhost/api/v1/runs/${started.runId}`, {
        method: "GET",
        headers: {
          "x-forwarded-for": "192.0.2.120",
        },
      }),
      {
        params: Promise.resolve({ runId: started.runId }),
      },
    );
    expect(limitedResponse.status).toBe(429);
  });

  test("status route includes provider failure details for actionable UI guidance", async () => {
    const env = await createIsolatedEnvironment();
    process.env.SQLITE_DB_PATH = env.sqlitePath;
    process.env.ARTIFACTS_DIR = env.artifactsDir;
    process.env.ARTIFACT_ROUTE_SIGNING_SECRET = "test-signing-secret";

    const engine = await createSQLiteRunEngine({ sqlitePath: env.sqlitePath, leaseDurationMs: 200 });
    await engine.initialize();
    const started = await engine.startRun({
      idempotencyKey: "provider-error-status",
      payload: {
        brief: "Create a short product video.",
        fixture_mode: false,
      },
    });

    const normalizeStage: StageHandler = async () => ({
      type: "success",
      data: {
        normalize: {
          prompt_metadata: [],
          repair_attempted: false,
          sanitized_brief: "sanitized",
          normalized_brief: {
            schemaVersion: "1.0.0",
            briefId: "b1",
            campaignName: "Provider Failure",
            objective: "Create a short product video.",
            language: "en",
            aspectRatio: "4:9",
            unresolvedQuestions: [],
            scenes: [
              {
                sceneId: "scene_1",
                sceneType: "intro",
                visualCriticality: "supporting",
                narrative: "Presenter in a studio",
                desiredTags: ["hero"],
                approvedAssetIds: ["hook-spokeswoman-dealpump"],
                generationMode: "asset_derived",
                requestedTransform: "overlay",
                durationSeconds: 4,
              },
            ],
          },
          reason_codes: [],
        },
      },
    });

    const validatePolicyStage: StageHandler = async (context) => ({
      type: "success",
      data: {
        validate_policy: {
          selected_asset_ids: ["hook-spokeswoman-dealpump"],
        },
        normalized_brief: (context.payload as { normalized_brief: unknown }).normalized_brief,
      },
    });

    const imageStage: StageHandler = async () => ({
      type: "success",
      data: {
        image_generation: {
          source_asset_ids: ["hook-spokeswoman-dealpump"],
          derived_stills: [
            {
              scene_id: "scene_1",
              source_asset_ids: ["hook-spokeswoman-dealpump"],
              provider_job_reference: "local-asset-scene_1",
              still_id: "still-scene_1",
              storage_path: "/tmp/scene_1.png",
              canonical_mime: "image/png",
              byte_size: 128,
              width: 1080,
              height: 2430,
              sha256: "sha-scene-1",
            },
          ],
        },
      },
    });

    const videoStage: StageHandler = async () => ({
      type: "fatal_error",
      reason: "veo provider failure for scene scene_1: usage guidelines",
      providerRef: "projects/test/operations/123",
      details: {
        stage: "video_generation",
        scene_id: "scene_1",
        failure_type: "provider_failed_status",
        provider_reason: "The prompt could not be submitted. This prompt contains words that violate Vertex AI's usage guidelines.",
        provider_reason_code: "29310472",
      },
    });

    const handlers = createStageHandlers({
      normalize: normalizeStage,
      validatePolicy: validatePolicyStage,
      imageGeneration: imageStage,
      videoGeneration: videoStage,
    });

    for (let index = 0; index < 8; index += 1) {
      const claim = await engine.claimNextJob();
      if (!claim) {
        await sleep(5);
        continue;
      }

      await engine.processClaim(claim, handlers);
    }

    await engine.close();

    const statusResponse = await getRunStatusRoute(
      new NextRequest(`http://localhost/api/v1/runs/${started.runId}`, {
        method: "GET",
        headers: {
          "x-forwarded-for": "192.0.2.140",
        },
      }),
      {
        params: Promise.resolve({ runId: started.runId }),
      },
    );
    expect(statusResponse.status).toBe(200);

    const statusPayload = (await statusResponse.json()) as {
      outcome: string;
      errorCode?: string;
      errorMessage?: string;
      failureType?: string;
      providerReason?: string;
      providerReasonCode?: string;
      sceneId?: string;
    };

    expect(statusPayload.outcome).toBe("provider_failed");
    expect(statusPayload.errorCode).toBe("provider_failed");
    expect(statusPayload.failureType).toBe("provider_failed_status");
    expect(statusPayload.providerReason).toContain("usage guidelines");
    expect(statusPayload.providerReasonCode).toBe("29310472");
    expect(statusPayload.sceneId).toBe("scene_1");
    expect(statusPayload.errorMessage).toContain("veo provider failure");
  });

  test("artifact route serves signed artifacts without exposing filesystem paths", async () => {
    const env = await createIsolatedEnvironment();
    const signingSecret = "test-signing-secret";
    process.env.ARTIFACT_ROUTE_SIGNING_SECRET = signingSecret;

    const setupEngine = await createSQLiteRunEngine({ sqlitePath: env.sqlitePath, leaseDurationMs: 200 });
    await setupEngine.initialize();
    const started = await setupEngine.startRun({
      idempotencyKey: "artifact-run",
      payload: {
        brief: "artifact",
        fixture_mode: true,
      },
    });
    await setupEngine.close();

    const normalizeStage: StageHandler = async () => {
      return {
        type: "success",
        data: {
          normalize: {
            prompt_metadata: [],
            repair_attempted: false,
            sanitized_brief: "sanitized",
            normalized_brief: {
              briefId: "b1",
            },
            reason_codes: [],
          },
        },
      };
    };

    const validatePolicyStage: StageHandler = async () => {
      return {
        type: "success",
        data: {
          validate_policy: {
            selected_asset_ids: ["brand-wordmark-primary"],
          },
        },
      };
    };

    const imageStage: StageHandler = async () => {
      return {
        type: "success",
        data: {
          image_generation: {
            source_asset_ids: ["brand-wordmark-primary"],
          },
        },
      };
    };

    const videoStage: StageHandler = async () => {
      return {
        type: "success",
        data: {
          video_generation: {
            derived_video_scenes: [],
          },
        },
      };
    };

    const expiresAt = "2036-04-02T12:00:00.000Z";
    const finalSignature = computeArtifactRouteSignature({
      runId: started.runId,
      artifactName: "final.mp4",
      expiresAtIso: expiresAt,
      signingSecret,
    });
    const provenanceSignature = computeArtifactRouteSignature({
      runId: started.runId,
      artifactName: "provenance.json",
      expiresAtIso: expiresAt,
      signingSecret,
    });
    const subtitlesStage: StageHandler = async (context) => {
      return {
        type: "success",
        data: {
          subtitles_export: {
            artifact_routes: {
              final_mp4: {
                route_path: `/api/v1/runs/${context.runId}/artifacts/final.mp4`,
                signed_path:
                  `/api/v1/runs/${context.runId}/artifacts/final.mp4?expires=${encodeURIComponent(expiresAt)}&signature=${finalSignature}`,
                expires_at: expiresAt,
                ttl_seconds: 24 * 60 * 60,
              },
              provenance_json: {
                route_path: `/api/v1/runs/${context.runId}/artifacts/provenance.json`,
                signed_path:
                  `/api/v1/runs/${context.runId}/artifacts/provenance.json?expires=${encodeURIComponent(expiresAt)}&signature=${provenanceSignature}`,
                expires_at: expiresAt,
                ttl_seconds: 24 * 60 * 60,
              },
            },
          },
        },
      };
    };

    await processRunUntil(
      env.sqlitePath,
      started.runId,
      createStageHandlers({
        normalize: normalizeStage,
        validatePolicy: validatePolicyStage,
        imageGeneration: imageStage,
        videoGeneration: videoStage,
        subtitlesExport: subtitlesStage,
      }),
      "completed",
    );

    const artifactDir = path.join(env.artifactsDir, "runs", started.runId);
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(path.join(artifactDir, "final.mp4"), Buffer.from("final-video"));
    await fs.writeFile(path.join(artifactDir, "provenance.json"), JSON.stringify({ run_id: started.runId }));

    const finalResponse = await getArtifactRoute(
      new Request(
        `http://localhost/api/v1/runs/${started.runId}/artifacts/final.mp4?expires=${encodeURIComponent(expiresAt)}&signature=${finalSignature}`,
      ),
      {
        params: Promise.resolve({
          runId: started.runId,
          artifactName: "final.mp4",
        }),
      },
    );

    expect(finalResponse.status).toBe(200);
    expect(finalResponse.headers.get("content-type")).toBe("video/mp4");
    await expect(finalResponse.text()).resolves.toContain("final-video");

    const invalidSignatureResponse = await getArtifactRoute(
      new Request(
        `http://localhost/api/v1/runs/${started.runId}/artifacts/final.mp4?expires=${encodeURIComponent(expiresAt)}&signature=wrong-signature`,
      ),
      {
        params: Promise.resolve({
          runId: started.runId,
          artifactName: "final.mp4",
        }),
      },
    );
    expect(invalidSignatureResponse.status).toBe(403);

    const invalidExpirySignatureResponse = await getArtifactRoute(
      new Request(
        `http://localhost/api/v1/runs/${started.runId}/artifacts/final.mp4?expires=${encodeURIComponent("2036-04-03T12:00:00.000Z")}&signature=${finalSignature}`,
      ),
      {
        params: Promise.resolve({
          runId: started.runId,
          artifactName: "final.mp4",
        }),
      },
    );
    expect(invalidExpirySignatureResponse.status).toBe(403);
  });

  test("start route succeeds when data directories are initially missing", async () => {
    await createIsolatedEnvironment({ createDirs: false });

    const response = await startRunRoute(
      new NextRequest("http://localhost/api/v1/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "missing-dirs-start",
          "x-forwarded-for": "203.0.113.77",
        },
        body: JSON.stringify({
          brief: "Create a simple fixture ad",
          fixtureMode: true,
        }),
      }),
    );

    expect(response.status).toBe(202);
    const payload = (await response.json()) as { runId: string };
    expect(payload.runId).toBeTruthy();
  });

  test("fixture-mode runtime composition reaches completed with status intermediate and artifact fields", async () => {
    const env = await createIsolatedEnvironment();

    const startResponse = await startRunRoute(
      new NextRequest("http://localhost/api/v1/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "fixture-runtime-complete",
          "x-forwarded-for": "203.0.113.201",
        },
        body: JSON.stringify({
          brief: "Create a simple fixture ad",
          fixtureMode: true,
        }),
      }),
    );

    expect(startResponse.status).toBe(202);
    const startPayload = (await startResponse.json()) as { runId: string };

    const approvedAssetsDir = path.join(env.tempRoot, "approved-assets");
    await fs.mkdir(approvedAssetsDir, { recursive: true });
    await fs.writeFile(path.join(approvedAssetsDir, "01-hook-spokeswoman-dealpump.png"), Buffer.from("intro-image"));
    await fs.writeFile(path.join(approvedAssetsDir, "02-product-demo-closeup.png"), Buffer.from("product-image"));

    const handlers = createStageHandlers({
      normalize: createOpenAINormalizeStageHandler({
        client: createFixtureOpenAIClient(),
        model: "gpt-5.4-mini",
      }),
      validatePolicy: createRuntimeValidatePolicyStageHandler(),
      imageGeneration: createPreGeneratedImageStageHandler({
        assetsRootDir: approvedAssetsDir,
        model: "pre_generated_assets",
      }),
      videoGeneration: createVeoVideoStageHandler({
        client: createFixtureVeoClient(),
        model: "veo-3.1-generate-preview",
        clock: {
          now: () => Date.now(),
          sleep: async () => {},
        },
      }),
      subtitlesExport: createSubtitlesExportStageHandler({
        artifactsRootDir: env.artifactsDir,
        tempRootDir: path.join(env.tempRoot, "tmp"),
        fixtureMode: false,
        commandRunner: createMockMediaRunner(),
        routeSigningSecret: "route-secret",
        now: () => new Date("2026-04-02T12:30:00.000Z"),
      }),
    });

    await processRunUntil(env.sqlitePath, startPayload.runId, handlers, "completed");

    const statusResponse = await getRunStatusRoute(
      new NextRequest(`http://localhost/api/v1/runs/${startPayload.runId}`, {
        method: "GET",
        headers: {
          "x-forwarded-for": "203.0.113.201",
        },
      }),
      {
        params: Promise.resolve({ runId: startPayload.runId }),
      },
    );

    expect(statusResponse.status).toBe(200);
    const statusPayload = (await statusResponse.json()) as {
      phase: string;
      outcome: string;
      normalizedBrief?: unknown;
      selectedAssetIds?: string[];
      resultUrl?: string;
      provenanceUrl?: string;
    };

    expect(statusPayload.phase).toBe("completed");
    expect(statusPayload.outcome).toBe("ok");
    expect(statusPayload.normalizedBrief).toBeDefined();
    expect(statusPayload.selectedAssetIds).toEqual([
      "hook-spokeswoman-dealpump",
      "product-demo-closeup",
    ]);
    expect(statusPayload.resultUrl).toContain(`/api/v1/runs/${startPayload.runId}/artifacts/final.mp4`);
    expect(statusPayload.provenanceUrl).toContain(`/api/v1/runs/${startPayload.runId}/artifacts/provenance.json`);
  });
});
