import { test, expect } from "@playwright/test";

test.describe("Autonomous Generated Tests", () => {
  test("[POSITIVE] Login with correct credentials", async ({ page }) => {
    await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login", { waitUntil: "networkidle" });
    await page.getByRole("textbox", { name: "Username" }).fill("Admin");
    await page.getByRole("textbox", { name: "Password" }).fill("admin123");
    await page.getByRole("button", { name: "Login" }).click();
    await expect(page).toHaveURL("https://opensource-demo.orangehrmlive.com/web/index.php/dashboard/index");
  });

  test("[POSITIVE] Login and click PIM", async ({ page }) => {
    await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login", { waitUntil: "networkidle" });
    await page.getByRole("textbox", { name: "Username" }).fill("Admin");
    await page.getByRole("textbox", { name: "Password" }).fill("admin123");
    await page.getByRole("button", { name: "Login" }).click();
    await page.getByRole("link", { name: "OrangeHRM, Inc" }).click();
    await expect(page).toHaveURL("https://opensource-demo.orangehrmlive.com/web/index.php/dashboard/index");
  });

  test("[NEGATIVE] Login with wrong password", async ({ page }) => {
    await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login", { waitUntil: "networkidle" });
    await page.getByRole("textbox", { name: "Username" }).fill("Admin");
    await page.getByRole("textbox", { name: "Password" }).fill("wrongpassword");
    await page.getByRole("button", { name: "Login" }).click();
    await expect(page.locator("[role='alert'], .alert, .error, [class*='error'], [class*='alert']")).toBeVisible();
  });

  test("[NEGATIVE] Login with wrong username", async ({ page }) => {
    await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login", { waitUntil: "networkidle" });
    await page.getByRole("textbox", { name: "Username" }).fill("wrongusername");
    await page.getByRole("textbox", { name: "Password" }).fill("admin123");
    await page.getByRole("button", { name: "Login" }).click();
    await expect(page.locator("[role='alert'], .alert, .error, [class*='error'], [class*='alert']")).toBeVisible();
  });

  test("[BOUNDARY] Login with empty username", async ({ page }) => {
    await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login", { waitUntil: "networkidle" });
    await page.getByRole("textbox", { name: "Username" }).fill("");
    await page.getByRole("textbox", { name: "Password" }).fill("admin123");
    await page.getByRole("button", { name: "Login" }).click();
    await expect(page.locator("[role='alert'], .alert, .error, [class*='error'], [class*='alert']")).toBeVisible();
  });

  test("[BOUNDARY] Login with single character username", async ({ page }) => {
    await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login", { waitUntil: "networkidle" });
    await page.getByRole("textbox", { name: "Username" }).fill("a");
    await page.getByRole("textbox", { name: "Password" }).fill("admin123");
    await page.getByRole("button", { name: "Login" }).click();
    await expect(page.locator("[role='alert'], .alert, .error, [class*='error'], [class*='alert']")).toBeVisible();
  });

  test("[EDGE] Login with SQL injection payload", async ({ page }) => {
    await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login", { waitUntil: "networkidle" });
    await page.locator("input[name='username']").fill("Admin' OR 1=1");
    await page.locator("input[name='password']").fill("admin123");
    await page.locator("button[type='submit']").click();
    await expect(page.locator("[role='alert'], .alert, .error, [class*='error'], [class*='alert']")).toBeVisible();
  });

  test("[EDGE] Login with XSS payload", async ({ page }) => {
    await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login", { waitUntil: "networkidle" });
    await page.getByRole("textbox", { name: "Username" }).fill("<script>alert('XSS')</script>");
    await page.getByRole("textbox", { name: "Password" }).fill("admin123");
    await page.getByRole("button", { name: "Login" }).click();
    await expect(page.locator("[role='alert'], .alert, .error, [class*='error'], [class*='alert']")).toBeVisible();
  });
});
