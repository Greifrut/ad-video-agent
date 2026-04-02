import { spawn } from "node:child_process";

function runCommand(command: string) {
  return spawn(command, {
    shell: true,
    stdio: "inherit",
    env: process.env,
  });
}

async function main(): Promise<void> {
  const webProcess = runCommand("pnpm dev");
  const workerProcess = runCommand("pnpm worker:dev");

  const terminateAll = () => {
    webProcess.kill("SIGTERM");
    workerProcess.kill("SIGTERM");
  };

  process.on("SIGINT", terminateAll);
  process.on("SIGTERM", terminateAll);

  const firstExitCode = await new Promise<number>((resolve) => {
    webProcess.once("exit", (code) => resolve(code ?? 1));
    workerProcess.once("exit", (code) => resolve(code ?? 1));
  });

  terminateAll();
  process.exit(firstExitCode);
}

main().catch((error) => {
  console.error("[dev:full] failed", error);
  process.exit(1);
});
