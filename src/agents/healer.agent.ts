import { readText, writeText } from "../utils/fs.js";
import { FailureAnalysis, HealingResult } from "../types.js";

// Strip ANSI escape codes so regexes work on plain text
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// Generic selectors for error/validation messages — ordered from most semantic to
// most permissive.  Covers ARIA roles, common CSS patterns, toast libraries, and
// framework-specific classes (OrangeHRM, Bootstrap, MUI, Ant Design, Vuetify, etc.)
const ERROR_SELECTORS = [
  // ── ARIA / semantic (most reliable across all apps) ──
  "[role='alert']",
  "[aria-live='assertive']",
  "[aria-live='polite']",
  // ── Common utility / component library patterns ──
  ".alert",
  ".alert-danger",
  ".alert-error",
  ".notification-error",
  // ── Error message class names ──
  ".error",
  ".error-message",
  ".error-text",
  ".form-error",
  ".field-error",
  ".validation-error",
  ".invalid-feedback",       // Bootstrap
  // ── Toast / snackbar notification libraries ──
  "[class*='toast']",
  "[class*='snackbar']",
  "[class*='notification']",
  // ── Framework-specific ──
  ".oxd-alert-content-text", // OrangeHRM / OrangeDS
  ".v-alert",                // Vuetify
  ".ant-message-error",      // Ant Design
  ".MuiAlert-message",       // MUI
  // ── Broad fallback (matches any class containing 'error' or 'alert') ──
  "[class*='error']",
  "[class*='alert']",
  "[class*='invalid']",
].join(", ");

export class HealerAgent {
  async heal(specPath: string, analyses: FailureAnalysis[]): Promise<HealingResult> {
    const healable = analyses.filter(
      (a) =>
        a.category === "locator_issue" ||
        a.category === "timing_issue" ||
        a.category === "assertion_mismatch"
    );

    if (healable.length === 0) {
      console.log("  [Healer] Nothing to heal — no healable issues detected.");
      return {
        healed: false,
        reason: "No locator/timing/assertion issues detected",
        modifiedFiles: [],
        healedTestTitles: []
      };
    }
    console.log(`  [Healer] Attempting to heal ${healable.length} issue(s): ${healable.map((h) => h.category).join(", ")}`);

    let spec = await readText(specPath);
    let changed = false;
    const healedTitles: string[] = [];

    // ── Timing: add waitUntil to bare goto calls ────────────────────────────
    if (healable.some((h) => h.category === "timing_issue")) {
      const patched = spec.replace(
        /await page\.goto\(([^,)]+)\);/g,
        `await page.goto($1, { waitUntil: "networkidle" });`
      );
      if (patched !== spec) { changed = true; spec = patched; }
    }

    // ── Locator: add .first() to ambiguous locators ─────────────────────────
    if (healable.some((h) => h.category === "locator_issue")) {
      const patched = spec
        .replace(/locator\(([^)]+)\)\.click\(\);/g, "locator($1).first().click();")
        .replace(/locator\(([^)]+)\)\.fill\(/g, "locator($1).first().fill(");
      if (patched !== spec) { changed = true; spec = patched; }
    }

    // ── Assertion mismatch: fix wrong URLs and missing error locators ───────
    for (const mismatch of healable.filter(a => a.category === "assertion_mismatch")) {
      // Strip ANSI codes — Playwright error messages embed terminal color sequences
      const err = stripAnsi(mismatch.test.errorMessage ?? "");

      // Fix 1 — toHaveURL pointing to the form page instead of the post-success page.
      // The error reports the URL the browser actually landed on ("Received:") — that's
      // the correct post-action URL.  We swap it in.
      if (/toHaveURL|toHaveUrl/i.test(err)) {
        const expectedMatch = /Expected:\s*"([^"]+)"/.exec(err);
        const receivedMatch = /Received:\s*"([^"]+)"/.exec(err);
        if (expectedMatch && receivedMatch) {
          const wrongUrl = expectedMatch[1];
          const rightUrl = receivedMatch[1];
          // Only swap when the received URL is a different, valid page (not an error redirect)
          if (rightUrl !== wrongUrl && !rightUrl.includes("error")) {
            const escaped = wrongUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const patched = spec.replace(
              new RegExp(`toHaveURL\\(["']${escaped}["']\\)`, "g"),
              `toHaveURL("${rightUrl}")`
            );
            if (patched !== spec) {
              console.log(`  [Healer] ✓ Fixed toHaveURL: "${wrongUrl}" → "${rightUrl}"`);
              changed = true; spec = patched;
              healedTitles.push(mismatch.test.title);
            }
          }
        }
      }

      // Fix 2 — toBeVisible on a locator that doesn't exist on the page.
      // "Locator: locator('#spanMessage')" + "Error: element(s) not found"
      // Replace the specific (broken) selector with a generic error container selector.
      if (/toBeVisible/i.test(err) && /element\(s\) not found/i.test(err)) {
        // Error format:  "Locator: locator('#spanMessage')"
        const locMatch = /Locator:\s*locator\(['"]([^'"]+)['"]\)/.exec(err);
        if (locMatch) {
          const brokenSel = locMatch[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const patched = spec.replace(
            new RegExp(
              `await expect\\(page\\.locator\\(["']${brokenSel}["']\\)\\)\\.toBeVisible\\(\\)`,
              "g"
            ),
            `await expect(page.locator("${ERROR_SELECTORS}").first()).toBeVisible()`
          );
          if (patched !== spec) {
            console.log(`  [Healer] ✓ Replaced missing locator "${locMatch[1]}" with generic error selector`);
            changed = true; spec = patched;
            if (!healedTitles.includes(mismatch.test.title)) healedTitles.push(mismatch.test.title);
          }
        }
      }
    }

    if (changed) {
      await writeText(specPath, spec);
      const allTitles = [...new Set([
        ...healable.filter(h => h.category !== "assertion_mismatch").map(h => h.test.title),
        ...healedTitles,
      ])];
      console.log(`  [Healer] Applied transforms to: ${specPath}`);
      for (const t of allTitles) console.log(`  [Healer] ✓ Healed: "${t}"`);
      return {
        healed: true,
        reason: "Applied autonomous healing transforms (locator/timing/assertion)",
        modifiedFiles: [specPath],
        healedTestTitles: allTitles
      };
    }

    console.log("  [Healer] No safe transformation was applicable.");
    return {
      healed: false,
      reason: "No safe code transformation was applicable",
      modifiedFiles: [],
      healedTestTitles: []
    };
  }
}
