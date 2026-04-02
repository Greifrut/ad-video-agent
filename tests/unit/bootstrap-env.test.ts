import path from "node:path";
import {
  DEPLOYMENT_SQLITE_PATH,
  loadBootstrapEnvironment,
  validateBootstrapEnvironment,
} from "@shared/index";

describe("bootstrap environment", () => {
  test("defaults to local .data directory in development", () => {
    const environment = loadBootstrapEnvironment({ NODE_ENV: "development" }, "/tmp/project");

    expect(environment.sqlitePath).toBe(path.join("/tmp/project", ".data", "deal-pump.sqlite"));
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

    expect(errors.some((error) => error.includes(DEPLOYMENT_SQLITE_PATH))).toBe(true);
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
    expect(errors).toContain("OPENAI_API_KEY is required when AI_PROVIDER_MODE=live.");
    expect(errors).toContain("VERTEX_PROJECT is required when AI_PROVIDER_MODE=live.");
    expect(errors).toContain("VERTEX_LOCATION is required when AI_PROVIDER_MODE=live.");
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
    expect(errors.some((entry) => entry.includes("GOOGLE_APPLICATION_CREDENTIALS must be absolute"))).toBe(true);
  });
});
