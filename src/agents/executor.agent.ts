import { spawn } from "node:child_process";
import { readText } from "../utils/fs.js";
import { FailedTestInfo, TestResult } from "../types.js";

interface PlaywrightJsonResult {
  suites?: Array<{
    suites?: PlaywrightJsonResult["suites"];
    specs?: Array<{
      title: string;
      file: string;
      tests: Array<{
        results: Array<{
          status: string;
          error?: { message?: string };
          attachments?: Array<{
            name?: string;
            contentType?: string;
            path?: string;
          }>;
          errorLocation?: {
            line?: number;
          };
        }>;
      }>;
    }>;
  }>;
}

export class ExecutorAgent {
  async run(specPath: string, workers: number): Promise<{ total: number; failed: FailedTestInfo[]; allResults: TestResult[] }> {
    await this.runCommand(
      `npx playwright test "${specPath}" --workers=${workers}`
    );

    const jsonRaw = await readText("reports/playwright-results.json");
    const parsed = JSON.parse(jsonRaw) as PlaywrightJsonResult;
    const result = collectResults(parsed);
    console.log(`  [Executor] Ran ${result.total} test(s) — ${result.failed.length === 0 ? "all passed" : `${result.failed.length} failed`}`);
    for (const f of result.failed) {
      console.log(`  [Executor] ✘ ${f.title}`);
      console.log(`    Error: ${f.errorMessage.split("\n")[0]}`);
    }
    return result;
  }

  async rerunByTitles(specPath: string, titles: string[], workers: number): Promise<{ failedAfterRerun: number; allResults: TestResult[] }> {
    if (titles.length === 0) return { failedAfterRerun: 0, allResults: [] };
    const grep = titles.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    console.log(`  [Executor Rerun] Rerunning ${titles.length} healed test(s): ${titles.join(", ")}`);
    await this.runCommand(
      `npx playwright test "${specPath}" --workers=${workers} --grep "${grep}"`
    );
    const jsonRaw = await readText("reports/playwright-results.json");
    const parsed = JSON.parse(jsonRaw) as PlaywrightJsonResult;
    const collected = collectResults(parsed);
    console.log(`  [Executor Rerun] After healing: ${collected.failed.length === 0 ? "all passed" : `${collected.failed.length} still failing`}`);
    return { failedAfterRerun: collected.failed.length, allResults: collected.allResults };
  }

  private async runCommand(command: string): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(command, { shell: true, stdio: "inherit" });
      child.on("error", reject);
      // Non-zero is expected for failing tests; caller parses JSON report.
      child.on("exit", (code) => resolve(code ?? 1));
    });
  }
}

function collectResults(parsed: PlaywrightJsonResult): { total: number; failed: FailedTestInfo[]; allResults: TestResult[] } {
  const failed: FailedTestInfo[] = [];
  const allResults: TestResult[] = [];
  let total = 0;

  const isNonPass = (s: string) => s !== "passed" && s !== "skipped" && s !== "pending";

  const walk = (suites: PlaywrightJsonResult["suites"] | undefined): void => {
    if (!suites) return;
    for (const suite of suites) {
      for (const spec of suite.specs ?? []) {
        for (const t of spec.tests) {
          total += 1;
          const firstResult = t.results[0];
          const status = firstResult?.status ?? "skipped";
          const durationMs = (firstResult as { duration?: number })?.duration ?? 0;
          const hasFailure = t.results.some((r) => isNonPass(r.status));
          const failedResult = hasFailure ? t.results.find((r) => isNonPass(r.status)) : undefined;
          const errorMsg = failedResult?.error?.message;

          allResults.push({
            title: spec.title,
            status: status as TestResult["status"],
            durationMs,
            ...(errorMsg ? { errorMessage: errorMsg } : {})
          });

          if (hasFailure && failedResult) {
            const msg = failedResult.error?.message ?? "Unknown error";
            const attachments = (failedResult.attachments ?? [])
              .filter((a) => Boolean(a.path))
              .map((a) => ({
                name: a.name ?? "artifact",
                contentType: a.contentType ?? "application/octet-stream",
                path: String(a.path)
              }));
            failed.push({
              title: spec.title,
              errorMessage: msg,
              file: spec.file,
              line: failedResult.errorLocation?.line,
              attachments
            });
          }
        }
      }
      walk(suite.suites);
    }
  };

  walk(parsed.suites);
  return { total, failed, allResults };
}
