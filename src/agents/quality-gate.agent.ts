import { FailureAnalysis } from "../types.js";

export class QualityGateAgent {
  evaluate(
    analyses: FailureAnalysis[],
    failedBefore: number,
    failedAfter: number,
    healedTitles: string[]
  ): "PASS" | "FAIL" {
    const healable = analyses.filter(
      (a) => a.category === "locator_issue" || a.category === "timing_issue"
    ).length;
    const healedCoverage = healable === 0 ? 1 : healedTitles.length / healable;
    const noRemaining = failedAfter === 0;
    const fullHealed = healedCoverage === 1 && failedBefore >= failedAfter;
    const result = noRemaining && fullHealed ? "PASS" : "FAIL";

    console.log(`  [Gate] Failed before healing : ${failedBefore}`);
    console.log(`  [Gate] Failed after healing  : ${failedAfter}`);
    console.log(`  [Gate] Healable issues        : ${healable}`);
    console.log(`  [Gate] Healed coverage        : ${Math.round(healedCoverage * 100)}%`);
    console.log(`  [Gate] Decision               : ${result}`);

    return result;
  }
}
