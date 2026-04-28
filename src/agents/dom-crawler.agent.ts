import { chromium, Browser, Page } from "@playwright/test";
import {
  TestPlan,
  TestCasePlan,
  LocatorStrategy,
  CrawledElement
} from "../types.js";
import { GroqClient } from "../utils/groq.js";

// Elements we care about for interaction and assertion
const INTERACTIVE_QUERY = [
  "button",
  "a[href]",
  "input:not([type=hidden])",
  "select",
  "textarea",
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  "[data-testid]",
  "[data-qa]",
  "[data-cy]",
  "[data-test]",
  "h1", "h2", "h3", "h4",
  "[aria-label]"
].join(", ");

// Custom test-id attributes to check, in priority order
const TEST_ID_ATTRS = ["data-testid", "data-qa", "data-cy", "data-test"];

const SEMANTIC_ROLES = new Set([
  "button", "link", "checkbox", "radio", "combobox",
  "textbox", "menuitem", "tab", "option", "switch", "heading"
]);

interface RawDOMElement {
  index: number;
  tagName: string;
  role: string;
  accessibleName: string;
  dataTestId: string | null;
  dataTestIdAttr: string;
  id: string | null;
  placeholder: string | null;
  inputType: string | null;
  name: string | null;
  visibleText: string;
  labelText: string | null;
}

function computeBestLocator(el: RawDOMElement): LocatorStrategy {
  // Prefer stable test-id attributes (data-qa, data-testid, etc.)
  if (el.dataTestId) {
    return { strategy: "locator", selector: `[${el.dataTestIdAttr}="${el.dataTestId}"]` };
  }
  const name = el.accessibleName.trim();
  if (name && SEMANTIC_ROLES.has(el.role)) {
    return { strategy: "getByRole", role: el.role, name };
  }
  if (el.labelText) {
    return { strategy: "getByLabel", label: el.labelText };
  }
  if (el.placeholder) {
    return { strategy: "getByPlaceholder", placeholder: el.placeholder };
  }
  const text = el.visibleText.trim();
  if (text && text.length > 1 && (el.tagName === "a" || el.tagName === "button")) {
    return { strategy: "getByText", text: text.slice(0, 50), exact: false };
  }
  if (el.id) {
    return { strategy: "locator", selector: `#${el.id}` };
  }
  if (el.name) {
    return { strategy: "locator", selector: `[name="${el.name}"]` };
  }
  return { strategy: "locator", selector: el.tagName };
}

export class DOMCrawlerAgent {
  constructor(private readonly groq?: GroqClient) {}

  async crawl(plan: TestPlan, baseUrl: string): Promise<TestPlan> {
    const browser = await chromium.launch({ headless: true });
    try {
      const resolvedCases: TestCasePlan[] = [];
      for (const tc of plan.cases) {
        try {
          const resolved = await this.crawlTestCaseFlow(browser, tc, baseUrl);
          resolvedCases.push(resolved);
        } catch (err) {
          console.warn(`  [DOM Crawler] Flow crawl failed for "${tc.title}": ${err instanceof Error ? err.message : String(err)}`);
          resolvedCases.push(tc);
        }
      }
      return { ...plan, cases: resolvedCases };
    } finally {
      await browser.close();
    }
  }

  // Drives a real browser through each step so we crawl the page that is
  // actually visible when each action is about to happen.
  private async crawlTestCaseFlow(
    browser: Browser,
    tc: TestCasePlan,
    baseUrl: string
  ): Promise<TestCasePlan> {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      // Use the URL from the first navigate step (the real target), not the dev-server baseUrl
      const firstNav = tc.steps.find(s => s.type === "navigate");
      const initialUrl = firstNav
        ? (firstNav.selector.startsWith("http") ? firstNav.selector : new URL(firstNav.selector, baseUrl).href)
        : baseUrl;
      console.log(`  [DOM Crawler] Starting crawl for "${tc.title}" at ${initialUrl}`);
      await page.goto(initialUrl, { waitUntil: "networkidle", timeout: 30000 });

      const resolvedSteps: TestCasePlan["steps"] = [];
      const resolvedValidations: TestCasePlan["validations"] = [];

      for (const step of tc.steps) {
        if (step.type === "navigate") {
          const url = step.selector.startsWith("http")
            ? step.selector
            : new URL(step.selector, baseUrl).href;
          await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
          resolvedSteps.push(step);
          continue;
        }

        // Crawl the current page state before deciding on a locator
        const elements = await this.extractElements(page);
        const resolved = await this.matchToElement(
          step.description,
          step.selector,
          step.type,
          elements
        );
        resolvedSteps.push({ ...step, ...(resolved ? { resolvedLocator: resolved } : {}) });

        // For click steps, actually perform the click so subsequent steps
        // see the correct next-page DOM.
        if (step.type === "click") {
          const beforeUrl = page.url();
          try {
            if (resolved) {
              await this.performClick(page, resolved);
            } else {
              await this.clickWithFallback(page, step.selector, step.description);
            }
            await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
            const afterUrl = page.url();
            if (afterUrl !== beforeUrl) {
              console.log(`  [DOM Crawler] Click navigated: ${afterUrl}`);
            }
          } catch (err) {
            console.warn(`  [DOM Crawler] Click failed for "${step.description}": ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
          }
        }
      }

      // Match validations against whatever page we landed on at the end
      const finalElements = await this.extractElements(page);
      const actualUrl = page.url();
      for (const validation of tc.validations) {
        if (validation.type === "assert_url") {
          // Replace the AI-guessed URL with the real URL the browser landed on
          const fixed = { ...validation, expected: actualUrl };
          console.log(`  [DOM Crawler] assert_url fixed: "${validation.expected}" → "${actualUrl}"`);
          resolvedValidations.push(fixed);
          continue;
        }
        const resolved = await this.matchToElement(
          validation.description,
          validation.target,
          "assert",
          finalElements
        );
        resolvedValidations.push({ ...validation, ...(resolved ? { resolvedLocator: resolved } : {}) });
      }

      const totalInteractive = [
        ...resolvedSteps.filter((s) => s.type !== "navigate"),
        ...resolvedValidations.filter((v) => v.type !== "assert_url")
      ].length;
      const resolvedCount = [
        ...resolvedSteps.filter((s) => s.type !== "navigate" && s.resolvedLocator),
        ...resolvedValidations.filter((v) => v.type !== "assert_url" && v.resolvedLocator)
      ].length;
      console.log(`  [DOM Crawler] "${tc.title}": ${resolvedCount}/${totalInteractive} locators resolved`);

      return { ...tc, steps: resolvedSteps, validations: resolvedValidations };
    } finally {
      await context.close();
    }
  }

  private async extractElements(page: Page): Promise<CrawledElement[]> {
    const rawElements: RawDOMElement[] = await page.evaluate(
      ({ query, testIdAttrs }: { query: string; testIdAttrs: string[] }) => {
        function getImplicitRole(el: Element): string {
          const tag = el.tagName.toLowerCase();
          const type = ((el as HTMLInputElement).type ?? "").toLowerCase();
          if (tag === "button" || (tag === "input" && ["submit", "button", "reset"].includes(type))) return "button";
          if (tag === "a") return "link";
          if (tag === "input" && type === "checkbox") return "checkbox";
          if (tag === "input" && type === "radio") return "radio";
          if (tag === "select") return "combobox";
          if (tag === "textarea" || tag === "input") return "textbox";
          if (["h1", "h2", "h3", "h4"].includes(tag)) return "heading";
          return el.getAttribute("role") ?? tag;
        }

        function getAccessibleName(el: Element): string {
          const ariaLabel = el.getAttribute("aria-label");
          if (ariaLabel) return ariaLabel;

          const labelledBy = el.getAttribute("aria-labelledby");
          if (labelledBy) {
            const ref = document.getElementById(labelledBy);
            if (ref) return ref.textContent?.trim() ?? "";
          }

          const id = el.getAttribute("id");
          if (id) {
            const label = document.querySelector(`label[for="${id}"]`);
            if (label) return label.textContent?.trim() ?? "";
          }

          const placeholder = (el as HTMLInputElement).placeholder;
          if (placeholder) return placeholder;

          return el.textContent?.trim().slice(0, 60) ?? "";
        }

        return Array.from(document.querySelectorAll(query))
          .slice(0, 200)
          .map((el, index) => {
            const id = el.getAttribute("id");
            const labelEl = id ? document.querySelector(`label[for="${id}"]`) : null;
            const foundAttr = testIdAttrs.find((a) => el.getAttribute(a));
            return {
              index,
              tagName: el.tagName.toLowerCase(),
              role: el.getAttribute("role") ?? getImplicitRole(el),
              accessibleName: getAccessibleName(el),
              dataTestId: foundAttr ? el.getAttribute(foundAttr) : null,
              dataTestIdAttr: foundAttr ?? "data-testid",
              id,
              placeholder: (el as HTMLInputElement).placeholder || null,
              inputType: (el as HTMLInputElement).type || null,
              name: el.getAttribute("name"),
              visibleText: el.textContent?.trim().slice(0, 80) ?? "",
              labelText: labelEl?.textContent?.trim() ?? null
            };
          });
      },
      { query: INTERACTIVE_QUERY, testIdAttrs: TEST_ID_ATTRS }
    );

    return rawElements.map((raw) => ({
      index: raw.index,
      tagName: raw.tagName,
      role: raw.role,
      accessibleName: raw.accessibleName,
      dataTestId: raw.dataTestId,
      elementId: raw.id,
      placeholder: raw.placeholder,
      inputType: raw.inputType,
      visibleText: raw.visibleText,
      labelText: raw.labelText,
      bestLocator: computeBestLocator(raw)
    }));
  }

  // Performs the click action during the crawl flow so the next step sees
  // the correct page. Tries the resolved locator first, falls back silently.
  private async performClick(page: Page, locator: LocatorStrategy): Promise<void> {
    const opts = { timeout: 5000 };
    switch (locator.strategy) {
      case "getByRole":
        await page.getByRole(locator.role as Parameters<typeof page.getByRole>[0], { name: locator.name }).click(opts);
        break;
      case "getByLabel":
        await page.getByLabel(locator.label).click(opts);
        break;
      case "getByTestId":
        await page.getByTestId(locator.testId).click(opts);
        break;
      case "getByText":
        await page.getByText(locator.text, { exact: locator.exact }).click(opts);
        break;
      case "getByPlaceholder":
        await page.getByPlaceholder(locator.placeholder).click(opts);
        break;
      case "locator":
        await page.locator(locator.selector).first().click(opts);
        break;
    }
  }

  // Tries multiple fallback strategies when we couldn't resolve a locator
  private async clickWithFallback(page: Page, selector: string, description: string): Promise<void> {
    const opts = { timeout: 5000 };
    const strategies: Array<() => Promise<void>> = [
      () => page.locator(selector).first().click(opts),
      () => page.getByText(description.replace(/^(click|tap|press)\s+/i, "").trim(), { exact: false }).first().click(opts),
      () => page.locator("a, button").filter({ hasText: new RegExp(description.split(/\s+/).slice(-2).join("|"), "i") }).first().click(opts),
    ];
    for (const fn of strategies) {
      try { await fn(); return; } catch { /* try next */ }
    }
    throw new Error(`All click fallbacks exhausted for: ${description}`);
  }

  private async matchToElement(
    description: string,
    originalSelector: string,
    actionType: string,
    elements: CrawledElement[]
  ): Promise<LocatorStrategy | null> {
    if (elements.length === 0) return null;
    // Heuristic is fast and always runs first; Groq refines ambiguous cases
    const heuristic = this.matchWithHeuristic(description, originalSelector, elements);
    if (heuristic) return heuristic;
    if (this.groq) {
      const groqResult = await this.matchWithGroq(description, originalSelector, actionType, elements);
      if (groqResult) return groqResult;
      // Groq returned null — heuristic already failed, nothing more to try
    }
    return null;
  }

  private matchWithHeuristic(
    description: string,
    originalSelector: string,
    elements: CrawledElement[]
  ): LocatorStrategy | null {
    const descLower = description.toLowerCase();
    const selLower = originalSelector.toLowerCase();

    // Extract meaningful keywords from description (skip short stop-words)
    const descKeywords = descLower.split(/\W+/).filter(w => w.length > 3);

    for (const el of elements) {
      const name = el.accessibleName.toLowerCase();
      const text = el.visibleText.toLowerCase();
      const label = (el.labelText ?? "").toLowerCase();
      const ph = (el.placeholder ?? "").toLowerCase();
      const testId = (el.dataTestId ?? "").toLowerCase();
      const elemId = (el.elementId ?? "").toLowerCase();

      // Phase 1: phrase-level match — description or selector contains the element's label/name
      if (
        (name.length > 1 && (descLower.includes(name) || selLower.includes(name))) ||
        (text.length > 1 && (descLower.includes(text) || selLower.includes(text))) ||
        (label.length > 1 && (descLower.includes(label) || selLower.includes(label))) ||
        (ph.length > 1 && (descLower.includes(ph) || selLower.includes(ph)))
      ) {
        return el.bestLocator;
      }

      // Phase 2: keyword match — any meaningful keyword from description appears in element tokens
      const elTokens = [name, text, label, ph, testId, elemId].join(" ");

      if (descKeywords.some(kw => elTokens.includes(kw))) {
        return el.bestLocator;
      }
    }
    return null;
  }

  private async matchWithGroq(
    description: string,
    originalSelector: string,
    actionType: string,
    elements: CrawledElement[]
  ): Promise<LocatorStrategy | null> {
    const top = elements.slice(0, 60);
    const elementList = top
      .map(
        (el, i) =>
          `${i}: <${el.tagName}> role="${el.role}" name="${el.accessibleName}" ` +
          `text="${el.visibleText.slice(0, 40)}" testid="${el.dataTestId ?? ""}" ` +
          `placeholder="${el.placeholder ?? ""}" label="${el.labelText ?? ""}"`
      )
      .join("\n");

    const prompt = `Match this test step to the best DOM element from the list below.

Step:
  action: ${actionType}
  description: ${description}
  original selector (may be wrong): ${originalSelector}

DOM elements on the current page:
${elementList}

Respond with JSON only (no markdown):
{"elementIndex": <number|null>, "reasoning": "<one line>"}`;

    try {
      const raw = await this.groq!.complete(prompt);
      const json = JSON.parse(raw.replace(/^```json|```$/gim, "").trim()) as {
        elementIndex: number | null;
        reasoning: string;
      };
      if (json.elementIndex === null || json.elementIndex < 0 || json.elementIndex >= top.length) {
        console.log(`  [DOM Crawler] Groq returned no match for "${description}"`);
        return null;
      }
      console.log(
        `  [DOM Crawler] Groq resolved "${description}" → index ${json.elementIndex} (${json.reasoning})`
      );
      return top[json.elementIndex].bestLocator;
    } catch (err) {
      console.warn(`  [DOM Crawler] Groq match failed for "${description}": ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      return null;
    }
  }
}
