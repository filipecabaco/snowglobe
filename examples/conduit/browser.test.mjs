import { chromium } from "../../bench/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto((process.env.CONDUIT_URL || "http://127.0.0.1:14173") + "/");
  await page
    .getByRole("heading", { name: "Welcome to Conduit", exact: true })
    .waitFor();
  await page.getByRole("link", { name: "Sign up", exact: true }).click();
  const username = "ui-" + Date.now();
  await page
    .getByRole("textbox", { name: "Username", exact: true })
    .fill(username);
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill(username + "@example.com");
  await page
    .getByRole("textbox", { name: "Password", exact: true })
    .fill("ui-password-2026");
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await page.getByRole("link", { name: "New Article", exact: true }).waitFor();
  await page.getByRole("link", { name: "New Article", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Article Title" })
    .fill("Browser check " + username);
  await page
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("A browser-tested article");
  await page
    .getByRole("textbox", { name: "Article body" })
    .fill(
      "## Markdown works\n\nA **real** article. <script>window.xss=true</script>",
    );
  await page
    .getByRole("textbox", { name: "Tags", exact: true })
    .fill("testing, browser");
  await page.getByRole("button", { name: "Publish Article" }).click();
  await page
    .getByRole("heading", { name: "Markdown works", exact: true })
    .waitFor();
  assert.equal(await page.evaluate(() => window.xss), undefined);
  await page
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("Test comment");
  await page.getByRole("button", { name: "Post Comment" }).click();
  await page.getByText("Test comment", { exact: true }).waitFor();
  await page.getByRole("button", { name: "♥ 0", exact: true }).click();
  await page.getByRole("button", { name: "♥ 1", exact: true }).waitFor();
  await page.getByRole("link", { name: "Edit article", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Article Title" })
    .fill("Edited " + username);
  await page.getByRole("button", { name: "Publish Article" }).click();
  await page
    .getByRole("heading", { name: "Edited " + username, exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Delete comment", exact: true })
    .click();
  await page
    .getByText("Test comment", { exact: true })
    .waitFor({ state: "hidden" });
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("link", { name: "demo", exact: true }).first().click();
  await page.getByRole("button", { name: "Follow demo", exact: true }).click();
  await page
    .getByRole("button", { name: "Unfollow demo", exact: true })
    .waitFor();
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: "Your Feed", exact: true }).click();
  await page
    .getByRole("heading", { name: "Welcome to Conduit", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("heading", { name: "Edited " + username, exact: true })
      .count(),
    0,
  );
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Bio", exact: true })
    .fill("A tested profile");
  await page.getByRole("button", { name: "Update Settings" }).click();
  await page.getByText("A tested profile", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Favorited Articles", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Edited " + username, exact: true })
    .click();
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Delete article", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Welcome to Conduit", exact: true })
    .waitFor();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await page.getByRole("link", { name: "Sign in", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS UI: signup, Markdown/XSS, article CRUD, comment CRUD, favorite, follow/feed, settings, logout, mobile layout",
  );
} catch (e) {
  console.error((await page.locator("body").innerText()).slice(0, 4000));
  throw e;
} finally {
  await browser.close();
}
