import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadLocalEnv } from "../../scripts/load-local-env";

const TEST_KEYS = [
  "DEAL_PUMP_ENV_BASE",
  "DEAL_PUMP_ENV_LOCAL",
  "DEAL_PUMP_ENV_DEV_LOCAL",
  "DEAL_PUMP_ENV_SHELL",
] as const;

afterEach(() => {
  for (const key of TEST_KEYS) {
    delete process.env[key];
  }
});

describe("loadLocalEnv", () => {
  test("loads local env files using Next-like development precedence", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deal-pump-env-"));

    await fs.writeFile(path.join(tempRoot, ".env"), "DEAL_PUMP_ENV_BASE=from-dotenv\nDEAL_PUMP_ENV_LOCAL=from-dotenv\n");
    await fs.writeFile(path.join(tempRoot, ".env.local"), "DEAL_PUMP_ENV_LOCAL=from-local\n");
    await fs.writeFile(path.join(tempRoot, ".env.development.local"), "DEAL_PUMP_ENV_DEV_LOCAL=from-dev-local\n");

    loadLocalEnv(tempRoot, "development");

    expect(process.env.DEAL_PUMP_ENV_BASE).toBe("from-dotenv");
    expect(process.env.DEAL_PUMP_ENV_LOCAL).toBe("from-local");
    expect(process.env.DEAL_PUMP_ENV_DEV_LOCAL).toBe("from-dev-local");
  });

  test("does not override variables already exported in the shell", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deal-pump-env-"));
    await fs.writeFile(path.join(tempRoot, ".env"), "DEAL_PUMP_ENV_SHELL=from-dotenv\n");

    process.env.DEAL_PUMP_ENV_SHELL = "from-shell";
    loadLocalEnv(tempRoot, "development");

    expect(process.env.DEAL_PUMP_ENV_SHELL).toBe("from-shell");
  });
});
