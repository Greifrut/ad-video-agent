import fs from "node:fs";
import path from "node:path";

function candidateEnvFiles(nodeEnv: string): string[] {
  const files = [`.env.${nodeEnv}.local`];

  if (nodeEnv !== "test") {
    files.push(".env.local");
  }

  files.push(`.env.${nodeEnv}`, ".env");
  return files;
}

export function loadLocalEnv(cwd = process.cwd(), nodeEnv = process.env.NODE_ENV ?? "development"): void {
  for (const fileName of candidateEnvFiles(nodeEnv)) {
    const filePath = path.join(cwd, fileName);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    process.loadEnvFile(filePath);
  }
}
