import "dotenv/config";
import { runPipeline } from "./pipeline.js";

function arg(name: string, fallback?: string): string | undefined {
  const key = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(key));
  return hit ? hit.slice(key.length) : fallback;
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "run";
  if (mode !== "run") {
    throw new Error(`Unsupported mode: ${mode}`);
  }

  const requirementPath = arg("requirement", "requirements.txt");
  const baseUrl = arg("baseUrl", process.env.BASE_URL ?? "http://localhost:3000") ?? "http://localhost:3000";
  const workers = Number(arg("workers", process.env.PLAYWRIGHT_WORKERS ?? "2"));

  if (!requirementPath) {
    throw new Error("Missing requirement path");
  }

  const result = await runPipeline({
    requirementPath,
    baseUrl,
    workers: Number.isNaN(workers) ? 2 : workers
  });

  console.log(JSON.stringify(result, null, 2));
  console.log(`Premium report generated at: ${result.reportPath}`);
}

main().catch((err) => {
  console.error("Autonomous QA pipeline failed.");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
