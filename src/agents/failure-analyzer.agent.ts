import { FailureAnalysis, FailureCategory, FailedTestInfo } from "../types.js";

export class FailureAnalyzerAgent {
  analyze(failedTests: FailedTestInfo[]): FailureAnalysis[] {
    if (failedTests.length === 0) {
      console.log("  [Analyzer] No failures to analyze.");
      return [];
    }
    const analyses = failedTests.map((test) => {
      const msg = test.errorMessage.toLowerCase();
      const category = this.classify(msg);
      return {
        test,
        category,
        confidence: this.confidence(category, msg),
        reasoning: this.reasoning(category, msg)
      };
    });
    console.log(`  [Analyzer] Analyzed ${analyses.length} failure(s):`);
    for (const a of analyses) {
      console.log(`  [Analyzer] • "${a.test.title}" → ${a.category} (${Math.round(a.confidence * 100)}% confidence)`);
    }
    return analyses;
  }

  private classify(msg: string): FailureCategory {
    // Assertion failures must be checked before timeout — many assertion errors
    // include a "Timeout: Xms" line that would otherwise cause misclassification.
    if (
      msg.includes("tohaveurl") ||
      msg.includes("tohavetext") ||
      msg.includes("tobevisible") ||
      msg.includes("tocontaintext") ||
      msg.includes("expect(") ||
      msg.includes("assertion")
    ) {
      return "assertion_mismatch";
    }
    if (msg.includes("strict mode violation") || msg.includes("locator") || msg.includes("selector")) {
      return "locator_issue";
    }
    if (msg.includes("timeout") || msg.includes("waiting")) {
      return "timing_issue";
    }
    if (msg.includes("net::") || msg.includes("network") || msg.includes("500")) {
      return "network_issue";
    }
    if (msg.includes("test data") || msg.includes("fixture")) {
      return "test_data_issue";
    }
    if (msg.includes("null") || msg.includes("undefined")) {
      return "probable_app_bug";
    }
    return "unknown";
  }

  private confidence(category: FailureCategory, msg: string): number {
    if (category === "unknown") return 0.4;
    if (msg.includes(category.split("_")[0])) return 0.9;
    return 0.75;
  }

  private reasoning(category: FailureCategory, msg: string): string {
    return `Classified as ${category} from error signature: ${msg.slice(0, 180)}`;
  }
}
