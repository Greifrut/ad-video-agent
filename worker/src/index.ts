import {
  createMockStageHandlers,
  createSQLiteRunEngine,
  loadBootstrapEnvironment,
  redactSecrets,
  validateBootstrapEnvironment,
} from "../../packages/shared/src/index";

const HEARTBEAT_MS = 2_500;
const IDLE_POLL_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
  const handlers = createMockStageHandlers();
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
