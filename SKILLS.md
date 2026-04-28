# Agent Skills Reference

This file describes the role, inputs, outputs, decision logic, and failure behaviour of every agent in the Autonomous QA Pipeline. Agents run sequentially; each one receives the outputs of all previous agents.

```
Requirements.txt
      │
      ▼
 1. Requirement Reader
      │ requirementText: string
      ▼
 2. Planner
      │ TestPlan (cases with steps + validations)
      ▼
 3. DOM Crawler
      │ TestPlan (same cases, now with resolvedLocator on each step)
      ▼
 4. Generator
      │ autonomous.spec.ts (Playwright TypeScript file)
      ▼
 5. Executor
      │ { total, failed[], allResults[] }
      ▼
 6. Failure Analyzer
      │ FailureAnalysis[] (category + confidence per failed test)
      ▼
 7. Healer
      │ HealingResult (modified spec + list of healed test titles)
      ▼
 8. Executor Rerun
      │ { failedAfterRerun, allResults[] }
      ▼
 9. Quality Gate ──► PASS / FAIL verdict
      │
      ▼
10. Reporter ──► HTML report + pipeline-live.json (real-time UI feed)
```

---

## 1 · Requirement Reader

**File:** `src/agents/requirement-reader.agent.ts`

**Purpose:** Load the raw requirement text so every downstream agent works from the same source.

**Input:** Path to a file — `.txt` (plain prose) or `.json` (structured spec).

**Output:** A plain `string` containing the requirement text.

**Decision logic:**
- If the file is `.json`, tries to extract `description`, then `title + body`, then falls back to the raw string.
- For any other extension (`.txt`, `.md`, etc.) it returns the content as-is.

**What it expects from requirements:**
- The URL of the application under test.
- A description of the flow to test (e.g. "login with username Admin and password admin123").
- Any specific acceptance criteria (e.g. "user should be redirected to dashboard after login").

**Failure behaviour:** Throws if the file does not exist or cannot be read.

---

## 2 · Planner

**File:** `src/agents/planner.agent.ts`

**Purpose:** Turn a human-readable requirement into a structured, machine-executable test plan covering all four test categories.

**Input:** `requirementText: string`

**Output:** `TestPlan` — a list of `TestCasePlan` objects, each with:
- `id` — sequential identifier (`TC-001`, `TC-002`, …)
- `title` — prefixed with `[POSITIVE]`, `[NEGATIVE]`, `[BOUNDARY]`, or `[EDGE]`
- `steps` — ordered actions (`navigate`, `click`, `type`, `select`)
- `validations` — assertions (`assert_url`, `assert_visibility`, `assert_text`)

**Decision logic:**

| Category | Input type | Assertion to use |
|----------|-----------|-----------------|
| `[POSITIVE]` | Exactly correct inputs | `assert_url` — expected value = the page the user lands on **after** the action (e.g. `/dashboard/index`), never the form page itself |
| `[NEGATIVE]` | Wrong / invalid inputs | `assert_visibility` — target = generic error selector chain (`[role='alert'], .alert, .error, [class*='error'], [class*='alert']`) |
| `[BOUNDARY]` | Empty fields, single chars, max-length, leading/trailing whitespace | `assert_visibility` — same error selector, never a success URL |
| `[EDGE]` | SQL injection, XSS payloads, special characters, whitespace-only | `assert_visibility` — same error selector |

**Rules the Planner must follow:**
- Every test case starts with a `navigate` step to the app URL.
- Minimum 2 cases per category (8 total).
- POSITIVE cases assert the *post-action* URL — never the starting page.
- Inputs with surrounding whitespace (e.g. `"  Admin  "`) are BOUNDARY, not POSITIVE.
- Error selectors must be the generic chain — never hard-coded IDs like `#spanMessage`.

**Fallback:** If `GROQ_API_KEY` is not set, returns a hardcoded single smoke-test plan instead of calling the LLM.

**Failure behaviour:** Throws if the LLM response cannot be parsed. Partial JSON responses are recovered by extracting complete case objects using bracket-depth tracking.

---

## 3 · DOM Crawler

**File:** `src/agents/dom-crawler.agent.ts`

**Purpose:** Launch a real Chromium browser, walk through each test case step-by-step, and resolve every abstract selector into the most stable Playwright locator the real DOM provides.

**Input:** `TestPlan` (from Planner) + `baseUrl: string`

**Output:** The same `TestPlan` with `resolvedLocator` populated on each step and validation where a match was found. Also fixes `assert_url` validations by replacing the AI-guessed URL with the actual URL the browser landed on.

**Locator priority (most to least stable):**

| Priority | Strategy | When used |
|----------|---------|-----------|
| 1 | `data-testid` / `data-qa` / `data-cy` / `data-test` | Element has a test-id attribute |
| 2 | `getByRole(role, { name })` | Element has an accessible name and a semantic ARIA role |
| 3 | `getByLabel(label)` | Input has an associated `<label>` |
| 4 | `getByPlaceholder(placeholder)` | Input has a placeholder |
| 5 | `getByText(text)` | Button or link with visible text |
| 6 | `locator('#id')` | Element has an `id` |
| 7 | `locator('[name="..."]')` | Element has a `name` attribute |
| 8 | `locator(tagName)` | Last resort fallback |

**Matching logic:**
1. **Heuristic first** — checks if the step description or original selector mentions the element's label, name, text, or placeholder. Fast, no API call needed.
2. **Groq fallback** — if heuristic fails and `GROQ_API_KEY` is set, sends the top 60 DOM elements to the LLM and asks it to pick the best match.

**Live navigation:** For `click` steps, the crawler actually performs the click so subsequent steps see the correct next-page DOM (e.g. after clicking Login, it sees the dashboard elements, not the login form).

**Failure behaviour:** If a test case flow fails (navigation error, element not found), the original unresolved case is kept and the pipeline continues. Logs a warning per failed case.

---

## 4 · Generator

**File:** `src/agents/generator.agent.ts`

**Purpose:** Translate the resolved `TestPlan` into a Playwright TypeScript test file that can be run directly by `npx playwright test`.

**Input:** `TestPlan` (with resolved locators from DOM Crawler) + `outputPath: string` + `baseUrl: string`

**Output:** Writes `tests/generated/autonomous.spec.ts`. Returns the output path.

**Code generation rules:**
- Steps use the `resolvedLocator` if available; falls back to `page.locator(originalSelector)`.
- `navigate` → `await page.goto(url, { waitUntil: "networkidle" })`
- `click` → `await locator.click()`
- `type` → `await locator.fill(value)`
- `select` → `await locator.selectOption(value)`
- `assert_url` → `await expect(page).toHaveURL(expected)`
- `assert_visibility` → `await expect(locator).toBeVisible()`
- `assert_text` → `await expect(locator).toContainText(expected)`

If the first step of a test case is already a `navigate`, no extra `page.goto(baseUrl)` is added at the top.

**Failure behaviour:** Throws only on file write errors.

---

## 5 · Executor

**File:** `src/agents/executor.agent.ts`

**Purpose:** Run the generated Playwright spec and collect pass/fail results for every test.

**Input:** `specPath: string` + `workers: number`

**Output:**
- `total` — number of tests run
- `failed[]` — array of `FailedTestInfo` with title, error message, file, line number, and any attachments (screenshots, videos, traces)
- `allResults[]` — pass/fail status and duration for every test

**How it works:**
- Spawns `npx playwright test <specPath> --workers=N` as a child process.
- Non-zero exit codes are expected (failing tests) and not treated as errors.
- Reads and parses `reports/playwright-results.json` (Playwright's JSON reporter output) to collect structured results.
- A test is marked as failed if *any* of its result attempts has a non-passing status (`failed`, `timedOut`, `interrupted`).

**Failure behaviour:** Throws if the JSON results file cannot be read or parsed.

---

## 6 · Failure Analyzer

**File:** `src/agents/failure-analyzer.agent.ts`

**Purpose:** Classify every failing test into a category so the Healer knows which fixes to apply.

**Input:** `FailedTestInfo[]` (from Executor)

**Output:** `FailureAnalysis[]` — one entry per failed test with:
- `category` — one of the values below
- `confidence` — 0.4 to 0.9
- `reasoning` — one-line explanation derived from the error message

**Classification rules (checked in order):**

| Category | Error signature |
|----------|----------------|
| `assertion_mismatch` | `toHaveURL`, `toHaveText`, `toBeVisible`, `toContainText`, `expect(`, `assertion` — checked **first** because assertion errors often also contain "Timeout" |
| `locator_issue` | `strict mode violation`, `locator`, `selector` |
| `timing_issue` | `timeout`, `waiting` |
| `network_issue` | `net::`, `network`, `500` |
| `test_data_issue` | `test data`, `fixture` |
| `probable_app_bug` | `null`, `undefined` |
| `unknown` | None of the above |

**Failure behaviour:** Never throws. Returns an empty array for zero failures.

---

## 7 · Healer

**File:** `src/agents/healer.agent.ts`

**Purpose:** Autonomously patch the generated spec to fix healable failures without human intervention.

**Input:** `specPath: string` + `FailureAnalysis[]`

**Output:** `HealingResult` — whether healing occurred, which files were modified, and which test titles were healed.

**Healable categories:** `locator_issue`, `timing_issue`, `assertion_mismatch`. Issues categorised as `network_issue`, `test_data_issue`, `probable_app_bug`, or `unknown` are skipped.

**Transforms applied:**

| Issue | Pattern detected | Fix applied |
|-------|-----------------|-------------|
| Timing | `await page.goto(url);` (no options) | Adds `{ waitUntil: "networkidle" }` |
| Locator (ambiguous) | `locator(x).click()` or `locator(x).fill(` | Inserts `.first()` before the action |
| Assertion — wrong URL | `toHaveURL` fails; error shows `Expected: "A"` / `Received: "B"` | Replaces URL `A` with `B` in spec (only when B doesn't contain `"error"`) |
| Assertion — missing element | `toBeVisible` fails with `element(s) not found`; error shows `Locator: locator('#x')` | Replaces the broken selector with the generic error selector chain |

**ANSI stripping:** Playwright error messages contain terminal colour escape sequences (`\x1b[31m…\x1b[39m`). All regex operations run on ANSI-stripped text.

**Generic error selector chain** (used when replacing broken element locators):
```
[role='alert'], [aria-live='assertive'], [aria-live='polite'],
.alert, .alert-danger, .alert-error, .notification-error,
.error, .error-message, .error-text, .form-error, .field-error,
.validation-error, .invalid-feedback,
[class*='toast'], [class*='snackbar'], [class*='notification'],
.oxd-alert-content-text, .v-alert, .ant-message-error, .MuiAlert-message,
[class*='error'], [class*='alert'], [class*='invalid']
```
This chain covers ARIA semantics, Bootstrap, MUI, Ant Design, Vuetify, OrangeHRM, and common toast/snackbar libraries.

**Failure behaviour:** If no safe transformation is applicable, returns `healed: false` and leaves the spec untouched.

---

## 8 · Executor Rerun

**File:** `src/agents/executor.agent.ts` (`rerunByTitles` method)

**Purpose:** Re-run only the tests that the Healer patched, to verify the fixes worked without re-running the entire suite.

**Input:** `specPath: string` + `healedTestTitles: string[]` + `workers: number`

**Output:**
- `failedAfterRerun` — how many healed tests are still failing
- `allResults[]` — results for the rerun subset

**How it works:**
- Builds a `--grep` regex from the healed test titles (special regex characters escaped).
- Runs `npx playwright test <specPath> --workers=N --grep "<pattern>"`.
- Parses the same `reports/playwright-results.json` to check outcomes.

**Skipped when:** The Healer reports `healed: false` (no titles to rerun).

---

## 9 · Quality Gate

**File:** `src/agents/quality-gate.agent.ts`

**Purpose:** Deliver the final GO / NO-GO verdict for the pipeline run.

**Input:**
- `analyses: FailureAnalysis[]`
- `failedBefore: number` — failures before healing
- `failedAfter: number` — failures after healing
- `healedTitles: string[]`

**Output:** `"PASS"` or `"FAIL"`

**Decision criteria — PASS requires ALL of:**
1. `failedAfter === 0` — no tests are still failing after healing.
2. All healable issues (locator + timing) were healed (`healedCoverage === 1`).
3. `failedBefore >= failedAfter` — healing did not make things worse.

**Failure behaviour:** Never throws. Logs each metric and the final decision.

---

## 10 · Reporter

**File:** `src/agents/reporter.agent.ts`

**Purpose:** Write a self-contained HTML report and update `reports/pipeline-live.json` (the real-time feed consumed by the UI).

**Input:** Full `PipelineResult` object + `outputPath: string`

**Output:**
- HTML report at `reports/pipeline-report.html` with agent status cards, metrics, and failure analysis table.
- `pipeline-live.json` updated after every agent run so the UI reflects real-time progress.

**Live feed:** The server watches `pipeline-live.json` with `fs.watchFile` and pushes `pipeline:update` events to all connected browser clients via Socket.io. This is how the agent cards animate as the pipeline progresses.

**Failure behaviour:** Throws only on file write errors.

---

## Data Contracts

Key types shared across all agents (`src/types.ts`):

```typescript
// A single locator strategy, in priority order
type LocatorStrategy =
  | { strategy: "getByTestId"; testId: string }
  | { strategy: "getByRole";   role: string; name: string }
  | { strategy: "getByLabel";  label: string }
  | { strategy: "getByPlaceholder"; placeholder: string }
  | { strategy: "getByText";   text: string; exact: boolean }
  | { strategy: "locator";     selector: string };

// One step in a test case
interface TestAction {
  type: "navigate" | "click" | "type" | "select";
  selector: string;       // original AI-generated selector
  value?: string;
  description: string;
  resolvedLocator?: LocatorStrategy; // set by DOM Crawler
}

// One assertion in a test case
interface TestValidation {
  type: "assert_url" | "assert_visibility" | "assert_text";
  target: string;
  expected: string;
  description: string;
  resolvedLocator?: LocatorStrategy; // set by DOM Crawler
}

// Failure categories the Analyzer can emit
type FailureCategory =
  | "locator_issue"        // Healer: add .first()
  | "timing_issue"         // Healer: add waitUntil
  | "assertion_mismatch"   // Healer: fix URL or swap broken locator
  | "network_issue"        // Not healable
  | "test_data_issue"      // Not healable
  | "probable_app_bug"     // Not healable
  | "unknown";             // Not healable
```

---

## Adding a New Agent

1. Create `src/agents/my-agent.agent.ts` and export a class with a single async method.
2. Import and instantiate it in `src/pipeline.ts`.
3. Call it in the right sequence, passing outputs from previous agents.
4. Record the result using the `runAgent` helper so `pipeline-live.json` is updated and the UI reflects the new agent.
5. Add the agent name to the `AGENTS` array in `ui/src/app/page.tsx` so it appears in the pipeline flow.
6. Document it in this file.
