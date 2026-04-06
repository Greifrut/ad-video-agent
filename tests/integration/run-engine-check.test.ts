import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runEngineCheck } from "@shared/index";

describe("run engine check", () => {
  test("passes with local writable paths", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deal-pump-bootstrap-"));
    const result = await runEngineCheck(
      {
        NODE_ENV: "development",
        DATA_DIR: tempRoot,
        SQLITE_DB_PATH: path.join(tempRoot, "deal-pump.sqlite"),
        ARTIFACTS_DIR: path.join(tempRoot, "artifacts"),
        REQUIRE_FFMPEG: "false",
      },
      tempRoot,
    );

    expect(result.pass).toBe(true);
    expect(result.checks.find((check) => check.name === "sqlite-pragmas")?.pass).toBe(true);
  });
});
