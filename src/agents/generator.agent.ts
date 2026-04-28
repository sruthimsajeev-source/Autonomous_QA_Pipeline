import { TestPlan, LocatorStrategy } from "../types.js";
import { writeText } from "../utils/fs.js";

function locatorToCode(loc: LocatorStrategy): string {
  switch (loc.strategy) {
    case "getByRole":
      return `page.getByRole(${JSON.stringify(loc.role)}, { name: ${JSON.stringify(loc.name)} })`;
    case "getByLabel":
      return `page.getByLabel(${JSON.stringify(loc.label)})`;
    case "getByTestId":
      return `page.getByTestId(${JSON.stringify(loc.testId)})`;
    case "getByText":
      return loc.exact
        ? `page.getByText(${JSON.stringify(loc.text)})`
        : `page.getByText(${JSON.stringify(loc.text)}, { exact: false })`;
    case "getByPlaceholder":
      return `page.getByPlaceholder(${JSON.stringify(loc.placeholder)})`;
    case "locator":
      return `page.locator(${JSON.stringify(loc.selector)})`;
  }
}

function toActionCode(step: TestPlan["cases"][number]["steps"][number]): string {
  if (step.type === "navigate") {
    return `await page.goto(${JSON.stringify(step.selector)}, { waitUntil: "networkidle" });`;
  }

  const locator = step.resolvedLocator
    ? locatorToCode(step.resolvedLocator)
    : `page.locator(${JSON.stringify(step.selector)})`;

  if (step.type === "click") {
    return `await ${locator}.click();`;
  }
  if (step.type === "type") {
    return `await ${locator}.fill(${JSON.stringify(step.value ?? "")});`;
  }
  // select
  return `await ${locator}.selectOption(${JSON.stringify(step.value ?? "")});`;
}

function toValidationCode(validation: TestPlan["cases"][number]["validations"][number]): string {
  if (validation.type === "assert_url") {
    return `await expect(page).toHaveURL(${JSON.stringify(validation.expected)});`;
  }

  const locator = validation.resolvedLocator
    ? locatorToCode(validation.resolvedLocator)
    : `page.locator(${JSON.stringify(validation.target)})`;

  if (validation.type === "assert_visibility") {
    return `await expect(${locator}).toBeVisible();`;
  }
  // assert_text
  return `await expect(${locator}).toContainText(${JSON.stringify(validation.expected)});`;
}

export class GeneratorAgent {
  async generate(plan: TestPlan, outputPath: string, baseUrl: string): Promise<string> {
    const resolvedCount = plan.cases.flatMap((tc) => [...tc.steps, ...tc.validations]).filter(
      (s) => "resolvedLocator" in s && s.resolvedLocator !== undefined
    ).length;

    const totalInteractive = plan.cases.flatMap((tc) => [
      ...tc.steps.filter((s) => s.type !== "navigate"),
      ...tc.validations.filter((v) => v.type !== "assert_url")
    ]).length;

    console.log(`  [Generator] Locator coverage: ${resolvedCount}/${totalInteractive} resolved from real DOM`);

    const tests = plan.cases
      .map((tc) => {
        const actions = tc.steps.map((s) => `    ${toActionCode(s)}`).join("\n");
        const validations = tc.validations.map((v) => `    ${toValidationCode(v)}`).join("\n");
        // Skip hardcoded initial goto if the plan already starts with a navigate step
        const firstStepIsNavigate = tc.steps[0]?.type === "navigate";
        const initialGoto = firstStepIsNavigate
          ? ""
          : `    await page.goto(${JSON.stringify(baseUrl)}, { waitUntil: "networkidle" });\n`;
        return `
  test(${JSON.stringify(tc.title)}, async ({ page }) => {
${initialGoto}${actions}
${validations}
  });`;
      })
      .join("\n");

    const spec = `import { test, expect } from "@playwright/test";

test.describe("Autonomous Generated Tests", () => {${tests}
});
`;

    await writeText(outputPath, spec);
    return outputPath;
  }
}
