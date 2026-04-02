import { spawn } from "node:child_process";
import {
  loadBootstrapEnvironment,
  redactSecrets,
  validateBootstrapEnvironment,
} from "../packages/shared/src/index";

type Mode = "dev" | "start";

function readMode(rawValue: string | undefined): Mode {
  if (rawValue === "start") {
    return rawValue;
  }

  return "dev";
}

async function main(): Promise<void> {
  const mode = readMode(process.argv[2]);
  const rawArgs = process.argv.slice(3);
  const nextArgs = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  const environment = loadBootstrapEnvironment(process.env);
  const validationErrors = validateBootstrapEnvironment(environment);

  if (validationErrors.length > 0) {
    throw new Error(`Invalid web bootstrap environment: ${validationErrors.join(" ")}`);
  }

  console.log(
    `[web] launching next ${mode}`,
    redactSecrets({
      NODE_ENV: environment.nodeEnv,
      SQLITE_DB_PATH: environment.sqlitePath,
      ARTIFACTS_DIR: environment.artifactsDir,
      WORKER_CONCURRENCY: environment.workerConcurrency,
    }),
  );

  const child = spawn("next", [mode, ...nextArgs], {
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      DATA_DIR: environment.dataDir,
      SQLITE_DB_PATH: environment.sqlitePath,
      ARTIFACTS_DIR: environment.artifactsDir,
      WORKER_CONCURRENCY: String(environment.workerConcurrency),
    },
  });

  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });
}

main().catch((error) => {
  console.error("[web] bootstrap failed", (error as Error).message);
  process.exit(1);
});
