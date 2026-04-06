import { loadLocalEnv } from "./load-local-env";
import { resolveGoogleCredentials } from "./resolve-google-credentials";
import { runEngineCheck } from "../packages/shared/src/index";

async function main(): Promise<void> {
  loadLocalEnv();
  await resolveGoogleCredentials();

  const result = await runEngineCheck(process.env);

  for (const check of result.checks) {
    const marker = check.pass ? "PASS" : "FAIL";
    console.log(`[${marker}] ${check.name}: ${check.details}`);
  }

  if (!result.pass) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("run-engine:check crashed", error);
  process.exit(1);
});
