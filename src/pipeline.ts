import { writeText } from "./utils/fs.js";
import { GroqClient } from "./utils/groq.js";
import { AgentRun, PipelineResult, TestPlan, TestResult } from "./types.js";
import { RequirementReaderAgent } from "./agents/requirement-reader.agent.js";
import { PlannerAgent } from "./agents/planner.agent.js";
import { DOMCrawlerAgent } from "./agents/dom-crawler.agent.js";
import { GeneratorAgent } from "./agents/generator.agent.js";
import { ExecutorAgent } from "./agents/executor.agent.js";
import { FailureAnalyzerAgent } from "./agents/failure-analyzer.agent.js";
import { HealerAgent } from "./agents/healer.agent.js";
import { QualityGateAgent } from "./agents/quality-gate.agent.js";
import { ReporterAgent } from "./agents/reporter.agent.js";

export interface PipelineInput {
  requirementPath: string;
  baseUrl: string;
  workers: number;
}

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const groqApiKey = process.env.GROQ_API_KEY;
  const groq = groqApiKey ? new GroqClient(groqApiKey) : undefined;
  const agentRuns: AgentRun[] = [];

  const reader = new RequirementReaderAgent();
  const planner = new PlannerAgent(groq);
  const crawler = new DOMCrawlerAgent(groq);
  const generator = new GeneratorAgent();
  const executor = new ExecutorAgent();
  const analyzer = new FailureAnalyzerAgent();
  const healer = new HealerAgent();
  const gate = new QualityGateAgent();
  const reporter = new ReporterAgent();

  let generatedSpecPath = "tests/generated/autonomous.spec.ts";
  let totalTests = 0;
  let failedBeforeHealing = 0;
  let failedAfterHealing = 0;
  let analyses: PipelineResult["analyses"] = [];
  let healing: PipelineResult["healing"] = {
    healed: false,
    reason: "Healing not started",
    modifiedFiles: [],
    healedTestTitles: []
  };
  let overallStatus: PipelineResult["overallStatus"] = "FAIL";
  let testPlan: TestPlan | undefined;
  let testResults: TestResult[] | undefined;
  const publish = async (): Promise<void> => {
    await writeText(
      "reports/pipeline-live.json",
      JSON.stringify(
        {
          pipelineState: "RUNNING",
          overallStatus,
          generatedSpecPath,
          totalTests,
          failedBeforeHealing,
          failedAfterHealing,
          analyses,
          healing,
          agentRuns,
          ...(testPlan ? { testPlan } : {}),
          ...(testResults ? { testResults } : {})
        },
        null,
        2
      )
    );
    await reporter.generate(
      {
        pipelineState: "RUNNING",
        overallStatus,
        generatedSpecPath,
        totalTests,
        failedBeforeHealing,
        failedAfterHealing,
        analyses,
        healing,
        agentRuns
      },
      "reports/autonomous-report.html"
    );
  };

  try {
    await publish();
    const requirementText = await runAgent("Requirement Reader", agentRuns, async () =>
      reader.read(input.requirementPath)
    );
    await publish();

    const plan = await runAgent("Planner", agentRuns, async () => planner.createPlan(requirementText));
    await writeText("reports/generated-test-plan.json", JSON.stringify(plan, null, 2));
    await publish();

    const resolvedPlan = await runAgent("DOM Crawler", agentRuns, async () =>
      crawler.crawl(plan, input.baseUrl)
    );
    testPlan = resolvedPlan;
    await writeText("reports/resolved-test-plan.json", JSON.stringify(resolvedPlan, null, 2));
    await publish();

    generatedSpecPath = await runAgent("Generator", agentRuns, async () =>
      generator.generate(resolvedPlan, "tests/generated/autonomous.spec.ts", input.baseUrl)
    );
    await publish();

    const run1 = await runAgent("Executor", agentRuns, async () =>
      executor.run(generatedSpecPath, input.workers)
    );
    totalTests = run1.total;
    failedBeforeHealing = run1.failed.length;
    failedAfterHealing = failedBeforeHealing;
    testResults = run1.allResults;
    await publish();

    analyses = await runAgent("Failure Analyzer", agentRuns, async () => analyzer.analyze(run1.failed));
    await publish();
    healing = await runAgent("Healer", agentRuns, async () =>
      healer.heal(generatedSpecPath, analyses)
    );
    await publish();

    if (healing.healedTestTitles.length > 0) {
      const rerun = await runAgent("Executor Rerun", agentRuns, async () =>
        executor.rerunByTitles(generatedSpecPath, healing.healedTestTitles, input.workers)
      );
      failedAfterHealing = rerun.failedAfterRerun;
      if (rerun.allResults.length > 0) {
        // Merge rerun results: replace re-tested titles with new results
        const rerunTitles = new Set(rerun.allResults.map(r => r.title));
        testResults = [
          ...(testResults ?? []).filter(r => !rerunTitles.has(r.title)),
          ...rerun.allResults
        ];
      }
      await publish();
    } else {
      agentRuns.push({
        agent: "Executor Rerun",
        status: "skipped",
        reason: "No healed test titles to rerun",
        durationMs: 0,
        logs: ["No tests required a rerun."]
      });
      await publish();
    }

    overallStatus = await runAgent("Quality Gate", agentRuns, async () =>
      gate.evaluate(analyses, failedBeforeHealing, failedAfterHealing, healing.healedTestTitles)
    );
    await publish();
  } catch (error) {
    agentRuns.push({
      agent: "Pipeline Orchestrator",
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
      durationMs: 0,
      logs: [error instanceof Error ? error.stack ?? error.message : String(error)]
    });
    overallStatus = "FAIL";
    await publish();
  }

  const reportPath = await reporter.generate(
    {
      pipelineState: "COMPLETED",
      overallStatus,
      generatedSpecPath,
      totalTests,
      failedBeforeHealing,
      failedAfterHealing,
      analyses,
      healing,
      agentRuns
    },
    "reports/autonomous-report.html"
  );
  await writeText(
    "reports/pipeline-live.json",
    JSON.stringify(
      {
        pipelineState: "COMPLETED",
        overallStatus,
        generatedSpecPath,
        totalTests,
        failedBeforeHealing,
        failedAfterHealing,
        analyses,
        healing,
        agentRuns,
        ...(testPlan ? { testPlan } : {}),
        ...(testResults ? { testResults } : {})
      },
      null,
      2
    )
  );

  return {
    pipelineState: "COMPLETED",
    overallStatus,
    generatedSpecPath,
    totalTests,
    failedBeforeHealing,
    failedAfterHealing,
    analyses,
    healing,
    agentRuns,
    reportPath
  };
}

async function runAgent<T>(
  agent: string,
  agentRuns: AgentRun[],
  task: () => Promise<T>
): Promise<T> {
  const started = Date.now();
  const logs: string[] = [];

  const origLog = console.log;
  const origWarn = console.warn;
  const capture = (...args: unknown[]) =>
    args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");

  console.log = (...args: unknown[]) => { logs.push(capture(...args)); origLog(...args); };
  console.warn = (...args: unknown[]) => { logs.push("[warn] " + capture(...args)); origWarn(...args); };

  const restore = () => { console.log = origLog; console.warn = origWarn; };

  try {
    const value = await task();
    restore();
    agentRuns.push({ agent, status: "success", reason: "Completed successfully", durationMs: Date.now() - started, logs });
    return value;
  } catch (error) {
    restore();
    agentRuns.push({ agent, status: "failed", reason: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started, logs });
    throw error;
  }
}
