import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type ResolveGoogleCredentialsOptions = {
  env?: NodeJS.ProcessEnv;
  tempDir?: string;
};

function readNonEmpty(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function resolveGoogleCredentials(
  options: ResolveGoogleCredentialsOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env;
  const existingPath = readNonEmpty(env.GOOGLE_APPLICATION_CREDENTIALS);
  if (existingPath) {
    return existingPath;
  }

  const inlineJson = readNonEmpty(env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  if (!inlineJson) {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(inlineJson);
  } catch {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON must contain valid JSON.");
  }

  if (!parsedJson || typeof parsedJson !== "object" || Array.isArray(parsedJson)) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON must decode to a JSON object.");
  }

  const tempDir = options.tempDir ?? os.tmpdir();
  const filePath = path.join(tempDir, `deal-pump-google-credentials-${process.pid}.json`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(parsedJson, null, 2)}\n`, { mode: 0o600 });

  env.GOOGLE_APPLICATION_CREDENTIALS = filePath;
  return filePath;
}
