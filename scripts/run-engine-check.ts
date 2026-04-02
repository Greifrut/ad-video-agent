import { runEngineCheck } from "@shared/index";

async function main(): Promise<void> {
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
