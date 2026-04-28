export type ActionType = "navigate" | "click" | "type" | "select";
export type ValidationType = "assert_url" | "assert_visibility" | "assert_text";

// Resilient Playwright locator strategies, in priority order:
// getByTestId > getByRole > getByLabel > getByPlaceholder > getByText > locator (fallback)
export type LocatorStrategy =
  | { strategy: "getByRole"; role: string; name: string }
  | { strategy: "getByLabel"; label: string }
  | { strategy: "getByTestId"; testId: string }
  | { strategy: "getByText"; text: string; exact: boolean }
  | { strategy: "getByPlaceholder"; placeholder: string }
  | { strategy: "locator"; selector: string };

export interface CrawledElement {
  index: number;
  tagName: string;
  role: string;
  accessibleName: string;
  dataTestId: string | null;
  elementId: string | null;
  placeholder: string | null;
  inputType: string | null;
  visibleText: string;
  labelText: string | null;
  bestLocator: LocatorStrategy;
}

export interface PageLocatorMap {
  url: string;
  elements: CrawledElement[];
}

export type LocatorCatalog = PageLocatorMap[];

export interface TestAction {
  type: ActionType;
  selector: string;
  value?: string;
  description: string;
  resolvedLocator?: LocatorStrategy; // populated by DOMCrawlerAgent from real DOM
}

export interface TestValidation {
  type: ValidationType;
  target: string;
  expected: string;
  description: string;
  resolvedLocator?: LocatorStrategy; // populated by DOMCrawlerAgent from real DOM
}

export interface TestCasePlan {
  id: string;
  title: string;
  steps: TestAction[];
  validations: TestValidation[];
}

export interface TestPlan {
  source: string;
  createdAt: string;
  cases: TestCasePlan[];
}

export interface FailedTestInfo {
  title: string;
  errorMessage: string;
  file: string;
  line?: number;
  attachments?: Array<{
    name: string;
    contentType: string;
    path: string;
  }>;
}

export type FailureCategory =
  | "locator_issue"
  | "probable_app_bug"
  | "timing_issue"
  | "assertion_mismatch"
  | "network_issue"
  | "test_data_issue"
  | "unknown";

export interface FailureAnalysis {
  test: FailedTestInfo;
  category: FailureCategory;
  confidence: number;
  reasoning: string;
}

export interface HealingResult {
  healed: boolean;
  reason: string;
  modifiedFiles: string[];
  healedTestTitles: string[];
}

export type AgentStatus = "success" | "failed" | "skipped";

export interface AgentRun {
  agent: string;
  status: AgentStatus;
  reason: string;
  durationMs: number;
  logs: string[];
}

export interface TestResult {
  title: string;
  status: "passed" | "failed" | "timedOut" | "skipped";
  durationMs: number;
  errorMessage?: string;
}

export interface PipelineResult {
  pipelineState: "RUNNING" | "COMPLETED";
  overallStatus: "PASS" | "FAIL";
  generatedSpecPath: string;
  totalTests: number;
  failedBeforeHealing: number;
  failedAfterHealing: number;
  analyses: FailureAnalysis[];
  healing: HealingResult;
  agentRuns: AgentRun[];
  reportPath: string;
  testPlan?: TestPlan;
  testResults?: TestResult[];
}
