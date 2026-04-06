import {
  DEPLOYMENT_SQLITE_PATH,
  loadBootstrapEnvironment,
  prepareBootstrapStorage,
  validateBootstrapEnvironment,
} from "@shared/index";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("bootstrap environment", () => {
  test("defaults to local .data directory in development", () => {
    const environment = loadBootstrapEnvironment(
      { NODE_ENV: "development" },
      "/tmp/project",
    );

    expect(environment.sqlitePath).toBe(
      path.join("/tmp/project", ".data", "deal-pump.sqlite"),
    );
    expect(environment.workerConcurrency).toBe(1);
    expect(environment.providerMode).toBe("fixture");
    expect(validateBootstrapEnvironment(environment)).toHaveLength(0);
  });

  test("enforces /data sqlite path in production", () => {
    const environment = loadBootstrapEnvironment(
      {
        NODE_ENV: "production",
        SQLITE_DB_PATH: "/tmp/deal-pump.sqlite",
      },
      "/tmp/project",
    );

    const errors = validateBootstrapEnvironment(environment);

    expect(errors.some((error) => error.includes(DEPLOYMENT_SQLITE_PATH))).toBe(
      true,
    );
  });

  test("requires provider credentials in live mode", () => {
    const environment = loadBootstrapEnvironment(
      {
        NODE_ENV: "development",
        AI_PROVIDER_MODE: "live",
      },
      "/tmp/project",
    );

    const errors = validateBootstrapEnvironment(environment);
    expect(errors).toContain(
      "OPENAI_API_KEY is required when AI_PROVIDER_MODE=live.",
    );
    expect(errors).toContain(
      "VERTEX_PROJECT is required when AI_PROVIDER_MODE=live.",
    );
    expect(errors).toContain(
      "VERTEX_LOCATION is required when AI_PROVIDER_MODE=live.",
    );
  });

  test("loads optional Vertex API key and custom video model", () => {
    const environment = loadBootstrapEnvironment(
      {
        NODE_ENV: "development",
        VERTEX_API_KEY: "vertex-api-key",
        VERTEX_VIDEO_MODEL: "veo-3.1-fast-generate-001",
      },
      "/tmp/project",
    );

    expect(environment.vertexApiKey).toBe("vertex-api-key");
    expect(environment.vertexVideoModel).toBe("veo-3.1-fast-generate-001");
  });

  test("defaults Vertex video model when unset", () => {
    const environment = loadBootstrapEnvironment(
      {
        NODE_ENV: "development",
      },
      "/tmp/project",
    );

    expect(environment.vertexVideoModel).toBe("veo-3.1-fast-generate-001");
  });

  test("requires absolute service account key path when configured", () => {
    const environment = loadBootstrapEnvironment(
      {
        NODE_ENV: "development",
        AI_PROVIDER_MODE: "live",
        OPENAI_API_KEY: "sk-test",
        VERTEX_PROJECT: "my-project",
        VERTEX_LOCATION: "us-central1",
        GOOGLE_APPLICATION_CREDENTIALS: "relative/key.json",
      },
      "/tmp/project",
    );

    const errors = validateBootstrapEnvironment(environment);
    expect(
      errors.some((entry) =>
        entry.includes("GOOGLE_APPLICATION_CREDENTIALS must be absolute"),
      ),
    ).toBe(true);
  });

  test("creates sqlite parent directory and artifacts directory", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "deal-pump-bootstrap-"),
    );
    const sqlitePath = path.join(
      tempRoot,
      "nested",
      "data",
      "deal-pump.sqlite",
    );
    const artifactsDir = path.join(tempRoot, "nested", "artifacts");

    await prepareBootstrapStorage({
      nodeEnv: "development",
      dataDir: path.join(tempRoot, "nested"),
      sqlitePath,
      artifactsDir,
      workerConcurrency: 1,
      ffmpegRequired: false,
      providerMode: "fixture",
      openaiApiKey: null,
      vertexApiKey: null,
      vertexProject: null,
      vertexLocation: null,
      vertexApiVersion: "v1",
      vertexVideoModel: "veo-3.1-fast-generate-001",
      googleApplicationCredentials: null,
    });

    const sqliteDirectory = await fs.stat(path.dirname(sqlitePath));
    const artifactsDirectory = await fs.stat(artifactsDir);

    expect(sqliteDirectory.isDirectory()).toBe(true);
    expect(artifactsDirectory.isDirectory()).toBe(true);
  });
});
