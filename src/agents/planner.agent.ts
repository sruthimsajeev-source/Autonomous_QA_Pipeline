import { z } from "zod";
import { TestPlan } from "../types.js";
import { GroqClient } from "../utils/groq.js";

const TestPlanSchema = z.object({
  source: z.string(),
  createdAt: z.string(),
  cases: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      steps: z.array(
        z.object({
          type: z.enum(["navigate", "click", "type", "select"]),
          selector: z.string(),
          value: z.string().optional(),
          description: z.string()
        })
      ),
      validations: z.array(
        z.object({
          type: z.enum(["assert_url", "assert_visibility", "assert_text"]),
          target: z.string(),
          expected: z.string(),
          description: z.string()
        })
      )
    })
  )
});

export class PlannerAgent {
  constructor(private readonly groq?: GroqClient) {}

  async createPlan(requirementText: string): Promise<TestPlan> {
    if (!this.groq) {
      console.log("  [Planner] No GROQ_API_KEY — using hardcoded fallback plan");
      const fallback: TestPlan = {
        source: "fallback",
        createdAt: new Date().toISOString(),
        cases: [
          {
            id: "TC-001",
            title: "Fallback smoke test",
            steps: [
              {
                type: "navigate",
                selector: "https://automationexercise.com",
                description: "Open application"
              },
              {
                type: "click",
                selector: "text=Signup / Login",
                description: "Click login link"
              }
            ],
            validations: [
              {
                type: "assert_visibility",
                target: "text=Dashboard",
                expected: "visible",
                description: "Dashboard should be visible"
              }
            ]
          }
        ]
      };
      this.logPlan(fallback);
      return fallback;
    }

    const prompt = `
Generate a COMPREHENSIVE Playwright test plan from the requirement below.
You MUST produce test cases for ALL FOUR categories — do not skip any:

  [POSITIVE]  Exactly correct inputs → expect success (redirect to a dashboard/home page)
  [NEGATIVE]  Wrong/invalid inputs → expect an error message on screen
  [BOUNDARY]  Empty fields, single character, max-length inputs, inputs with leading/trailing whitespace
  [EDGE]      SQL injection, XSS payload, special characters, whitespace-only inputs

Rules:
- Every test case must start with a navigate step to the app URL.
- Include every UI interaction: click links, fill fields, click submit buttons.
- For NEGATIVE / BOUNDARY / EDGE cases use assert_visibility with target="[role='alert'], .alert, .error, [class*='error'], [class*='alert']"
  to confirm an error message is visible — do NOT assert a success redirect.
- For POSITIVE cases use assert_url. The expected URL MUST be the page the user
  lands on AFTER the action succeeds — typically a dashboard, home, or profile page.
  NEVER assert the same URL as the starting page (e.g., do not assert the login URL
  after a successful login — that page only stays when login fails).
- Inputs with surrounding whitespace (e.g., "  Admin  ") are BOUNDARY tests, not POSITIVE.
  Most apps trim input before validation, so whitespace-padded credentials will be rejected.
- Generate at least 2 cases per category (8 cases minimum total).
- Title must start with the category tag, e.g. "[NEGATIVE] Login with wrong password".
- IDs must be sequential: TC-001, TC-002, …

Requirement:
${requirementText}

Return ONLY valid JSON — no markdown fences, no explanation.
`;
    const system = `You are a senior QA engineer. Output a JSON test plan matching this exact schema:
{
  "source": "string (base URL)",
  "createdAt": "ISO datetime",
  "cases": [
    {
      "id": "TC-001",
      "title": "[CATEGORY] descriptive title",
      "steps": [
        {"type": "navigate|click|type|select", "selector": "string", "value": "optional", "description": "string"}
      ],
      "validations": [
        {"type": "assert_url|assert_visibility|assert_text", "target": "string", "expected": "string", "description": "string"}
      ]
    }
  ]
}

Validation guidance:
- assert_url        → POSITIVE cases only. Expected must be the POST-ACTION page, never the form/login page itself.
- assert_visibility → NEGATIVE/BOUNDARY/EDGE: target must be "[role='alert'], .alert, .error, [class*='error'], [class*='alert']". Never use ids like #spanMessage or #error.
- assert_text       → NEGATIVE/BOUNDARY/EDGE: confirm specific error text content.
`;
    console.log("  [Planner] Calling Groq to generate comprehensive test plan...");
    const text = await this.groq.complete(prompt, system, 8192);
    console.log(`  [Planner] Groq returned ${text.length} chars`);
    const jsonText = text.replace(/^```json|```$/gim, "").trim();
    let rawPlan: Record<string, unknown>;
    try {
      rawPlan = parseWithRecovery(jsonText);
    } catch (err) {
      console.log(`  [Planner] Parse failed. Raw response (first 400 chars):\n${text.slice(0, 400)}`);
      throw err;
    }
    const normalized = normalizePlan(rawPlan);
    const plan = TestPlanSchema.parse(normalized);
    this.logPlan(plan);
    return plan;
  }

  private logPlan(plan: import("../types.js").TestPlan): void {
    const byCategory = (title: string) => {
      if (title.startsWith("[POSITIVE]")) return "POSITIVE";
      if (title.startsWith("[NEGATIVE]")) return "NEGATIVE";
      if (title.startsWith("[BOUNDARY]")) return "BOUNDARY";
      if (title.startsWith("[EDGE]"))     return "EDGE";
      return "POSITIVE";
    };
    const counts: Record<string, number> = {};
    for (const tc of plan.cases) counts[byCategory(tc.title)] = (counts[byCategory(tc.title)] ?? 0) + 1;
    console.log(`  [Planner] Generated ${plan.cases.length} test case(s) — ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
    for (const tc of plan.cases) {
      console.log(`  [Planner] • ${tc.id}: "${tc.title}"`);
      for (const s of tc.steps) console.log(`    ↳ ${s.type}: ${s.description}`);
      for (const v of tc.validations) console.log(`    ✓ ${v.type}: ${v.description}`);
    }
  }
}

// Attempts a normal parse; if truncated, locates the "cases" array and extracts
// every complete case object from it using bracket-depth tracking.
function parseWithRecovery(jsonText: string): Record<string, unknown> {
  try {
    return JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    const sourceMatch = /"source"\s*:\s*"([^"]*)"/.exec(jsonText);
    const createdAtMatch = /"createdAt"\s*:\s*"([^"]*)"/.exec(jsonText);

    // Find the "cases" array opening bracket
    const casesKeyIdx = jsonText.indexOf('"cases"');
    if (casesKeyIdx === -1) throw new Error("Could not recover any complete test cases from Groq response");
    const arrayOpen = jsonText.indexOf("[", casesKeyIdx);
    if (arrayOpen === -1) throw new Error("Could not recover any complete test cases from Groq response");

    // Scan the content INSIDE the cases array at depth 0 relative to the array
    const inside = jsonText.slice(arrayOpen + 1);
    const cases: unknown[] = [];
    let depth = 0;
    let objStart = -1;

    for (let i = 0; i < inside.length; i++) {
      const ch = inside[i];
      if (ch === "{") {
        if (depth === 0) objStart = i;
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0 && objStart !== -1) {
          try {
            const obj = JSON.parse(inside.slice(objStart, i + 1)) as Record<string, unknown>;
            if (obj.id && Array.isArray(obj.steps)) cases.push(obj);
          } catch { /* incomplete / malformed object — skip */ }
          objStart = -1;
        }
      }
    }

    if (cases.length === 0) {
      throw new Error("Could not recover any complete test cases from Groq response");
    }

    console.log(`  [Planner] JSON was truncated — recovered ${cases.length} complete test case(s)`);
    return {
      source: sourceMatch?.[1] ?? "groq",
      createdAt: createdAtMatch?.[1] ?? new Date().toISOString(),
      cases
    };
  }
}

function normalizePlan(input: Record<string, unknown>): Record<string, unknown> {
  const plan = { ...input };
  const rawCases = Array.isArray(plan.cases) ? plan.cases : [];

  plan.cases = rawCases.map((rawCase, caseIndex) => {
    const tc = (rawCase ?? {}) as Record<string, unknown>;
    const steps = Array.isArray(tc.steps) ? tc.steps : [];
    const validations = Array.isArray(tc.validations) ? tc.validations : [];

    const normalizedSteps = steps.map((rawStep, stepIndex) => {
      const step = (rawStep ?? {}) as Record<string, unknown>;
      const rawType = String(step.type ?? "").toLowerCase();
      const normalizedType =
        rawType === "navigate" || rawType === "goto"
          ? "navigate"
          : rawType === "fill" || rawType === "input"
            ? "type"
            : rawType === "choose"
              ? "select"
              : rawType === "click" || rawType === "type" || rawType === "select"
                ? rawType
                : "click";

      const navigateTarget = step.value ?? step.url ?? step.target ?? step.selector;
      return {
        type: normalizedType,
        selector: String(
          normalizedType === "navigate"
            ? (navigateTarget ?? "/")
            : (step.selector ?? step.target ?? "body")
        ),
        value: step.value === undefined ? undefined : String(step.value),
        description: String(step.description ?? `Step ${caseIndex + 1}.${stepIndex + 1}`)
      };
    });

    const normalizedValidations = validations.map((rawValidation, validationIndex) => {
      const validation = (rawValidation ?? {}) as Record<string, unknown>;
      const type = String(validation.type ?? "assert_visibility").toLowerCase();
      const target = String(validation.target ?? "body");
      const expectedFallback =
        type === "assert_url" ? "/" : type === "assert_text" ? "expected text" : "visible";

      return {
        type,
        target,
        expected: String(validation.expected ?? expectedFallback),
        description: String(
          validation.description ?? `Validation ${caseIndex + 1}.${validationIndex + 1}`
        )
      };
    });

    return {
      id: String(tc.id ?? `TC-${String(caseIndex + 1).padStart(3, "0")}`),
      title: String(tc.title ?? `Generated Test ${caseIndex + 1}`),
      steps: normalizedSteps,
      validations: normalizedValidations
    };
  });

  plan.source = String(plan.source ?? "groq");
  plan.createdAt = String(plan.createdAt ?? new Date().toISOString());
  return plan;
}
