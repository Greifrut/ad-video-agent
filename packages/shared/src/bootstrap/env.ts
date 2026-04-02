import path from "node:path";
import {
  DEPLOYMENT_ARTIFACTS_DIR,
  DEPLOYMENT_DATA_DIR,
  DEPLOYMENT_SQLITE_PATH,
} from "./constants";

export type BootstrapEnvironment = {
  nodeEnv: string;
  dataDir: string;
  sqlitePath: string;
  artifactsDir: string;
  workerConcurrency: number;
  ffmpegRequired: boolean;
  providerMode: "fixture" | "live";
  openaiApiKey: string | null;
  vertexProject: string | null;
  vertexLocation: string | null;
  vertexApiVersion: string;
  googleApplicationCredentials: string | null;
};

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseProviderMode(value: string | undefined): "fixture" | "live" {
  const normalized = value?.trim().toLowerCase() ?? "fixture";
  return normalized === "live" ? "live" : "fixture";
}

function readOptionalNonEmpty(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function loadBootstrapEnvironment(
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): BootstrapEnvironment {
  const nodeEnv = env.NODE_ENV ?? "development";
  const defaultDataDir = nodeEnv === "production" ? DEPLOYMENT_DATA_DIR : path.join(cwd, ".data");
  const dataDir = env.DATA_DIR ?? defaultDataDir;

  return {
    nodeEnv,
    dataDir,
    sqlitePath: env.SQLITE_DB_PATH ?? path.join(dataDir, "deal-pump.sqlite"),
    artifactsDir: env.ARTIFACTS_DIR ?? path.join(dataDir, "artifacts"),
    workerConcurrency: Number.parseInt(env.WORKER_CONCURRENCY ?? "1", 10),
    ffmpegRequired: parseBoolean(env.REQUIRE_FFMPEG, nodeEnv === "production"),
    providerMode: parseProviderMode(env.AI_PROVIDER_MODE),
    openaiApiKey: readOptionalNonEmpty(env.OPENAI_API_KEY),
    vertexProject: readOptionalNonEmpty(env.VERTEX_PROJECT),
    vertexLocation: readOptionalNonEmpty(env.VERTEX_LOCATION),
    vertexApiVersion: env.VERTEX_API_VERSION?.trim() || "v1",
    googleApplicationCredentials: readOptionalNonEmpty(env.GOOGLE_APPLICATION_CREDENTIALS),
  };
}

export function validateBootstrapEnvironment(configuration: BootstrapEnvironment): string[] {
  const errors: string[] = [];

  if (!Number.isInteger(configuration.workerConcurrency) || configuration.workerConcurrency !== 1) {
    errors.push("WORKER_CONCURRENCY must be exactly 1 for SQLite safety.");
  }

  if (!path.isAbsolute(configuration.sqlitePath)) {
    errors.push(`SQLITE_DB_PATH must be absolute. Received: ${configuration.sqlitePath}`);
  }

  if (!path.isAbsolute(configuration.artifactsDir)) {
    errors.push(`ARTIFACTS_DIR must be absolute. Received: ${configuration.artifactsDir}`);
  }

  if (configuration.nodeEnv === "production") {
    if (configuration.sqlitePath !== DEPLOYMENT_SQLITE_PATH) {
      errors.push(
        `In production SQLITE_DB_PATH must be ${DEPLOYMENT_SQLITE_PATH}. Received: ${configuration.sqlitePath}`,
      );
    }

    if (configuration.artifactsDir !== DEPLOYMENT_ARTIFACTS_DIR) {
      errors.push(
        `In production ARTIFACTS_DIR must be ${DEPLOYMENT_ARTIFACTS_DIR}. Received: ${configuration.artifactsDir}`,
      );
    }
  }

  if (configuration.providerMode === "live") {
    if (!configuration.openaiApiKey) {
      errors.push("OPENAI_API_KEY is required when AI_PROVIDER_MODE=live.");
    }

    if (!configuration.vertexProject) {
      errors.push("VERTEX_PROJECT is required when AI_PROVIDER_MODE=live.");
    }

    if (!configuration.vertexLocation) {
      errors.push("VERTEX_LOCATION is required when AI_PROVIDER_MODE=live.");
    }

  }

  if (
    configuration.googleApplicationCredentials &&
    !path.isAbsolute(configuration.googleApplicationCredentials)
  ) {
    errors.push(
      `GOOGLE_APPLICATION_CREDENTIALS must be absolute when provided. Received: ${configuration.googleApplicationCredentials}`,
    );
  }

  return errors;
}
