import fs from "node:fs/promises";
import path from "node:path";
import {
  createRuntimeNormalizeStageHandler,
  createRuntimeValidatePolicyStageHandler,
  createStageHandlers,
  createSubtitlesExportStageHandler,
  createSQLiteRunEngine,
  loadBootstrapEnvironment,
  redactSecrets,
  type MediaCommandRunner,
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
  });

  console.log("[worker] bootstrap ready", safeConfig);
}

async function main(): Promise<void> {
  failFastOnInvalidBootstrap();
  const configuration = loadBootstrapEnvironment(process.env);
  const handlers = createStageHandlers({
    normalize: createRuntimeNormalizeStageHandler(),
    validatePolicy: createRuntimeValidatePolicyStageHandler(),
    subtitlesExport: createSubtitlesExportStageHandler({
      artifactsRootDir: configuration.artifactsDir,
      fixtureMode: configuration.nodeEnv !== "production",
      commandRunner: configuration.nodeEnv === "production" ? undefined : createFixtureMediaCommandRunner(),
      routeSigningSecret: process.env.ARTIFACT_ROUTE_SIGNING_SECRET ?? "dev-artifact-route-secret",
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
