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
});
