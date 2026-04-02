import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  MIN_SQLITE_VERSION,
  SQLITE_RUNTIME_GUARDS,
} from "./constants";
import {
  loadBootstrapEnvironment,
  validateBootstrapEnvironment,
} from "./env";

type CheckResult = {
  name: string;
  pass: boolean;
  details: string;
};

export type RunEngineCheckResult = {
  pass: boolean;
  checks: CheckResult[];
};

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;

    if (leftValue > rightValue) {
      return 1;
    }

    if (leftValue < rightValue) {
      return -1;
    }
  }

  return 0;
}

async function ensureWritableDirectory(directoryPath: string): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true });
  const probeFile = path.join(directoryPath, `.probe-${Date.now()}`);
  await fs.writeFile(probeFile, "ok", "utf8");
  await fs.unlink(probeFile);
}

function assertBinary(binaryName: string): void {
  const command = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(command, [binaryName], { stdio: "ignore" });

  if (result.status !== 0) {
    throw new Error(`${binaryName} is required but not available in PATH.`);
  }
}

type SQLiteProbeResult = {
  sqliteVersion: string;
  journal_mode: string;
  synchronous: number;
  busy_timeout: number;
  foreign_keys: number;
  trusted_schema: number;
};

function probeSqlite(sqlitePath: string): SQLiteProbeResult {
  assertBinary("python3");

  const script = `
import json
import sqlite3
import sys

db_path = sys.argv[1]
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

cursor.execute("PRAGMA journal_mode=WAL;")
cursor.execute("PRAGMA synchronous=NORMAL;")
cursor.execute("PRAGMA busy_timeout=5000;")
cursor.execute("PRAGMA foreign_keys=ON;")
cursor.execute("PRAGMA trusted_schema=OFF;")

result = {
  "sqliteVersion": sqlite3.sqlite_version,
  "journal_mode": cursor.execute("PRAGMA journal_mode;").fetchone()[0],
  "synchronous": cursor.execute("PRAGMA synchronous;").fetchone()[0],
  "busy_timeout": cursor.execute("PRAGMA busy_timeout;").fetchone()[0],
  "foreign_keys": cursor.execute("PRAGMA foreign_keys;").fetchone()[0],
  "trusted_schema": cursor.execute("PRAGMA trusted_schema;").fetchone()[0],
}

conn.close()
print(json.dumps(result))
`;

  const result = spawnSync("python3", ["-c", script, sqlitePath], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        "python3 sqlite probe failed (requires python3 stdlib module 'sqlite3').",
    );
  }

  return JSON.parse(result.stdout.trim()) as SQLiteProbeResult;
}

export async function runEngineCheck(
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): Promise<RunEngineCheckResult> {
  const checks: CheckResult[] = [];
  const configuration = loadBootstrapEnvironment(env, cwd);
  const strictVersionCheck = configuration.nodeEnv === "production";
  const validationErrors = validateBootstrapEnvironment(configuration);

  checks.push({
    name: "bootstrap-env",
    pass: validationErrors.length === 0,
    details:
      validationErrors.length === 0
        ? "Environment contract is valid."
        : validationErrors.join(" "),
  });

  try {
    await ensureWritableDirectory(path.dirname(configuration.sqlitePath));
    checks.push({
      name: "sqlite-directory-writable",
      pass: true,
      details: `${path.dirname(configuration.sqlitePath)} is writable.`,
    });
  } catch (error) {
    checks.push({
      name: "sqlite-directory-writable",
      pass: false,
      details: `Cannot write SQLite directory: ${(error as Error).message}`,
    });
  }

  try {
    await ensureWritableDirectory(configuration.artifactsDir);
    checks.push({
      name: "artifacts-directory-writable",
      pass: true,
      details: `${configuration.artifactsDir} is writable.`,
    });
  } catch (error) {
    checks.push({
      name: "artifacts-directory-writable",
      pass: false,
      details: `Cannot write artifacts directory: ${(error as Error).message}`,
    });
  }

  try {
    const sqliteProbe = probeSqlite(configuration.sqlitePath);

    const guardValues: Record<string, string | number> = {
      journal_mode: sqliteProbe.journal_mode.toLowerCase(),
      synchronous: sqliteProbe.synchronous,
      busy_timeout: sqliteProbe.busy_timeout,
      foreign_keys: sqliteProbe.foreign_keys,
      trusted_schema: sqliteProbe.trusted_schema,
    };

    const versionOk = compareVersions(sqliteProbe.sqliteVersion, MIN_SQLITE_VERSION) >= 0;

    checks.push({
      name: "sqlite-version",
      pass: strictVersionCheck ? versionOk : true,
      details: strictVersionCheck
        ? `Detected SQLite ${sqliteProbe.sqliteVersion}, required >= ${MIN_SQLITE_VERSION}.`
        : `Detected SQLite ${sqliteProbe.sqliteVersion}. Production requires >= ${MIN_SQLITE_VERSION}.`,
    });

    const pragmaPass =
      guardValues.journal_mode === SQLITE_RUNTIME_GUARDS.journal_mode &&
      guardValues.synchronous === SQLITE_RUNTIME_GUARDS.synchronous &&
      guardValues.busy_timeout === SQLITE_RUNTIME_GUARDS.busy_timeout &&
      guardValues.foreign_keys === SQLITE_RUNTIME_GUARDS.foreign_keys &&
      guardValues.trusted_schema === SQLITE_RUNTIME_GUARDS.trusted_schema;

    checks.push({
      name: "sqlite-pragmas",
      pass: pragmaPass,
      details: `PRAGMA values: ${JSON.stringify(guardValues)}`,
    });
  } catch (error) {
    checks.push({
      name: "sqlite-version",
      pass: false,
      details: `Failed to probe SQLite version: ${(error as Error).message}`,
    });
    checks.push({
      name: "sqlite-pragmas",
      pass: false,
      details: `Failed to initialize/check SQLite PRAGMAs: ${(error as Error).message}`,
    });
  }

  if (configuration.ffmpegRequired) {
    try {
      assertBinary("ffmpeg");
      assertBinary("ffprobe");
      checks.push({
        name: "ffmpeg-prerequisites",
        pass: true,
        details: "ffmpeg and ffprobe are available.",
      });
    } catch (error) {
      checks.push({
        name: "ffmpeg-prerequisites",
        pass: false,
        details: (error as Error).message,
      });
    }
  } else {
    checks.push({
      name: "ffmpeg-prerequisites",
      pass: true,
      details: "Skipped (REQUIRE_FFMPEG is false outside production).",
    });
  }

  return {
    pass: checks.every((check) => check.pass),
    checks,
  };
}
