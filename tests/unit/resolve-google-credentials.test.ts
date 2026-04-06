import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { resolveGoogleCredentials } from "../../scripts/resolve-google-credentials";

describe("resolveGoogleCredentials", () => {
  test("writes GOOGLE_APPLICATION_CREDENTIALS_JSON to a temp file and exposes its path", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deal-pump-google-creds-"));
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify({
        type: "service_account",
        project_id: "video-creation-492415",
        client_email: "railway@example.com",
      }),
    };

    const filePath = await resolveGoogleCredentials({ env, tempDir: tempRoot });

    expect(filePath).toBe(path.join(tempRoot, `deal-pump-google-credentials-${process.pid}.json`));
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe(filePath);

    const contents = await fs.readFile(filePath!, "utf8");
    expect(contents).toContain('"type": "service_account"');
    expect(contents).toContain('"project_id": "video-creation-492415"');
  });

  test("prefers GOOGLE_APPLICATION_CREDENTIALS when already provided", async () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/existing-google-credentials.json",
      GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify({ type: "service_account" }),
    };

    const filePath = await resolveGoogleCredentials({ env, tempDir: os.tmpdir() });

    expect(filePath).toBe("/tmp/existing-google-credentials.json");
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe("/tmp/existing-google-credentials.json");
  });
});
