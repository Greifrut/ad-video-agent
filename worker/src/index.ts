import fs from "node:fs/promises";
import path from "node:path";
import {
  createGeminiImageStageHandler,
  createOpenAINormalizeStageHandler,
  createOpenAIResponsesSdkClient,
  createRuntimeValidatePolicyStageHandler,
  createStageHandlers,
  createSubtitlesExportStageHandler,
  createVertexGeminiFlashImageClient,
  createVertexVeoVideoClient,
  createSQLiteRunEngine,
  createVeoVideoStageHandler,
  loadBootstrapEnvironment,
  redactSecrets,
  resolveArtifactRouteSigningSecret,
  type GeminiFlashImageClient,
  type MediaCommandRunner,
  type OpenAIResponsesClient,
  type StageHandler,
  type VeoVideoClient,
  validateBootstrapEnvironment,
} from "../../packages/shared/src/index";

const HEARTBEAT_MS = 2_500;
const IDLE_POLL_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createFixtureMediaCommandRunner(): MediaCommandRunner {
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
          width: 1280,
          height: 720,
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
      width: 1280,
      height: 720,
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
        format: {
          duration: String(metadata.duration),
        },
      }),
      stderr: "",
    };
  };
}

function createFixtureOpenAIClient(): OpenAIResponsesClient {
  return {
    createResponse: async (request) => {
      const userMessage = request.input.find((entry) => entry.role === "user")?.content ?? "";
      const briefText = userMessage
        .replace("UNTRUSTED_BRIEF_CONTENT_START", "")
        .replace("UNTRUSTED_BRIEF_CONTENT_END", "")
        .trim();

      return {
        id: `fixture-openai-${Date.now()}`,
        output_text: JSON.stringify({
          schemaVersion: "1.0.0",
          briefId: `fixture-brief-${Date.now()}`,
          campaignName: "Fixture runtime campaign",
          objective: briefText || "Create a simple fixture ad",
          language: "en",
          aspectRatio: "16:9",
          unresolvedQuestions: [],
          scenes: [
            {
              sceneId: "scene-intro",
              sceneType: "intro",
              visualCriticality: "supporting",
              narrative: "Opening reveal with approved logo and studio background.",
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
              narrative: "Product hero frame with controlled motion and packshot emphasis.",
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

function createFixtureGeminiClient(): GeminiFlashImageClient {
  return {
    generateSceneStill: async (request) => {
      return {
        provider_job_reference: `fixture-gemini-${request.scene.sceneId}`,
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
        latencyMs: 500,
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
  };
}

function isFixtureModePayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const fixtureMode = (payload as { fixture_mode?: unknown }).fixture_mode;
  return fixtureMode === true;
}

function composeProviderStageHandler(
  providerMode: "fixture" | "live",
  fixtureHandler: StageHandler,
  liveHandler: StageHandler,
): StageHandler {
  if (providerMode === "fixture") {
    return fixtureHandler;
  }

  return async (context) => {
    if (isFixtureModePayload(context.payload)) {
      return await fixtureHandler(context);
    }

    return await liveHandler(context);
  };
}

function failFastOnInvalidBootstrap(): void {
  const configuration = loadBootstrapEnvironment(process.env);
  const validationErrors = validateBootstrapEnvironment(configuration);

  if (validationErrors.length > 0) {
    throw new Error(`Invalid worker bootstrap environment: ${validationErrors.join(" ")}`);
  }

  const safeConfig = redactSecrets({
    NODE_ENV: configuration.nodeEnv,
    DATA_DIR: configuration.dataDir,
    SQLITE_DB_PATH: configuration.sqlitePath,
    ARTIFACTS_DIR: configuration.artifactsDir,
    WORKER_CONCURRENCY: configuration.workerConcurrency,
    AI_PROVIDER_MODE: configuration.providerMode,
    VERTEX_PROJECT: configuration.vertexProject,
    VERTEX_LOCATION: configuration.vertexLocation,
    VERTEX_API_VERSION: configuration.vertexApiVersion,
    OPENAI_API_KEY: configuration.openaiApiKey,
    GOOGLE_APPLICATION_CREDENTIALS: configuration.googleApplicationCredentials,
  });

  console.log("[worker] bootstrap ready", safeConfig);
}

async function main(): Promise<void> {
  failFastOnInvalidBootstrap();
  const configuration = loadBootstrapEnvironment(process.env);

  if (configuration.googleApplicationCredentials) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = configuration.googleApplicationCredentials;
  }

  const artifactRouteSigningSecret = resolveArtifactRouteSigningSecret(process.env, configuration.nodeEnv);

  const fixtureNormalizeStage = createOpenAINormalizeStageHandler({
    client: createFixtureOpenAIClient(),
    model: "gpt-5.4-mini",
  });

  const fixtureImageStage = createGeminiImageStageHandler({
    client: createFixtureGeminiClient(),
    model: "gemini-2.5-flash-image",
    approvedAssetsRootDir: path.resolve(process.cwd(), "public/assets/approved"),
  });

  const fixtureVideoStage = createVeoVideoStageHandler({
    client: createFixtureVeoClient(),
    model: "veo-3.1-generate-preview",
    clock: {
      now: () => Date.now(),
      sleep: async () => {},
    },
  });

  const liveNormalizeStage = createOpenAINormalizeStageHandler({
    client: createOpenAIResponsesSdkClient({
      apiKey: configuration.openaiApiKey ?? "",
    }),
    model: "gpt-5.4-mini",
  });

  const liveImageStage = createGeminiImageStageHandler({
    client: createVertexGeminiFlashImageClient({
      project: configuration.vertexProject ?? "",
      location: configuration.vertexLocation ?? "",
      apiVersion: configuration.vertexApiVersion,
      outputRootDir: configuration.artifactsDir,
    }),
    model: "gemini-2.5-flash-image",
    approvedAssetsRootDir: path.resolve(process.cwd(), "public/assets/approved"),
  });

  const liveVideoStage = createVeoVideoStageHandler({
    client: createVertexVeoVideoClient({
      project: configuration.vertexProject ?? "",
      location: configuration.vertexLocation ?? "",
      apiVersion: configuration.vertexApiVersion,
      outputRootDir: configuration.artifactsDir,
    }),
    model: "veo-3.1-generate-preview",
  });

  const handlers = createStageHandlers({
    normalize: composeProviderStageHandler(
      configuration.providerMode,
      fixtureNormalizeStage,
      liveNormalizeStage,
    ),
    validatePolicy: createRuntimeValidatePolicyStageHandler(),
    imageGeneration: composeProviderStageHandler(
      configuration.providerMode,
      fixtureImageStage,
      liveImageStage,
    ),
    videoGeneration: composeProviderStageHandler(
      configuration.providerMode,
      fixtureVideoStage,
      liveVideoStage,
    ),
    subtitlesExport: createSubtitlesExportStageHandler({
      artifactsRootDir: configuration.artifactsDir,
      fixtureMode: configuration.nodeEnv !== "production",
      commandRunner: configuration.nodeEnv === "production" ? undefined : createFixtureMediaCommandRunner(),
      routeSigningSecret: artifactRouteSigningSecret,
    }),
  });
  const runEngine = await createSQLiteRunEngine({
    sqlitePath: configuration.sqlitePath,
    workerId: "worker-main",
  });
  await runEngine.initialize();
  const recoveredLeases = await runEngine.recoverStaleLeases();

  if (recoveredLeases > 0) {
    console.log(`[worker] recovered ${recoveredLeases} stale lease(s)`);
  }

  console.log("[worker] loop started");
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`[worker] received ${signal}, exiting.`);
    await runEngine.close();
    process.exit(0);
  };

  process.on("SIGINT", (signal) => {
    void shutdown(signal);
  });

  process.on("SIGTERM", (signal) => {
    void shutdown(signal);
  });

  while (!shuttingDown) {
    const claim = await runEngine.claimNextJob();
    if (!claim) {
      await sleep(IDLE_POLL_MS);
      continue;
    }

    const heartbeat = setInterval(() => {
      void runEngine.renewLease(claim.jobId, claim.leaseToken);
    }, HEARTBEAT_MS);

    try {
      await runEngine.processClaim(claim, handlers);
    } finally {
      clearInterval(heartbeat);
    }
  }
}

void main();
