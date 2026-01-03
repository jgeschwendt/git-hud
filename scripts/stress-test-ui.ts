#!/usr/bin/env bun
/**
 * UI Stress test using Playwright
 * Clone repo via UI, then rapidly add 5 worktrees via input field
 *
 * Run with: bun scripts/stress-test-ui.ts
 */

import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const TEST_REPO = "git@github.com:jgeschwendt/grove.git";
const REPO_NAME = "grove";

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  log("=== UI STRESS TEST: Clone + 5 rapid worktrees ===\n");

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  // Listen to console errors
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      log(`[CONSOLE ERROR] ${msg.text()}`);
    }
  });

  try {
    // Navigate to app
    log("Navigating to app...");
    await page.goto(BASE_URL);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);

    // Check if repo already exists - capture its worktrees before deleting
    log(`Checking for existing ${REPO_NAME} repo...`);
    const repoRegex = new RegExp(`^${REPO_NAME}$`);
    const existingRepo = page.locator("h3", { hasText: repoRegex }).first();

    // Default branches to create
    let branchesToCreate = [
      "ui-wt-1",
      "ui-wt-2",
      "ui-wt-3",
      "ui-wt-4",
      "ui-wt-5",
      "ui-wt-6",
      "ui-wt-7",
      "ui-wt-8",
      "ui-wt-9",
      "ui-wt-10",
    ];

    if (await existingRepo.isVisible({ timeout: 2000 }).catch(() => false)) {
      log(`Found existing ${REPO_NAME} repo, reading worktrees...`);

      // Get existing worktrees from API
      const apiRes = await fetch(`${BASE_URL}/api/repositories`);
      const repos = await apiRes.json();
      const existingRepoData = repos.find((r: any) => r.name === REPO_NAME);

      if (existingRepoData?.worktrees?.length > 0) {
        // Get non-main worktree branches
        const existingBranches = existingRepoData.worktrees
          .filter((wt: any) => wt.branch !== existingRepoData.default_branch)
          .map((wt: any) => wt.branch);

        if (existingBranches.length > 0) {
          branchesToCreate = existingBranches;
          log(
            `Will recreate ${branchesToCreate.length} existing worktrees: ${branchesToCreate.join(", ")}`,
          );
        }
      }

      // Delete the repo
      log(`Deleting ${REPO_NAME} repo...`);
      const repoRow = existingRepo.locator("xpath=ancestor::tr");
      const deleteBtn = repoRow
        .locator('button[title="Delete repository"]')
        .first();

      // Handle confirm dialog
      page.once("dialog", async (dialog) => {
        log(`Confirming delete: "${dialog.message()}"`);
        await dialog.accept();
      });

      await deleteBtn.click();

      // Wait for repo to actually disappear from UI
      log("Waiting for repo to be removed from UI...");
      await page.waitForFunction(
        (name) => {
          const headings = document.querySelectorAll("h3");
          return !Array.from(headings).some(
            (h) => h.textContent?.trim() === name,
          );
        },
        REPO_NAME,
        { timeout: 30000 },
      );
      // Extra buffer for filesystem cleanup
      await page.waitForTimeout(1000);
      log("Deleted existing repo");
    } else {
      log(`No existing ${REPO_NAME} repo, will create with default worktrees`);
    }

    // Click Clone button (uses title attribute, icon-only button)
    log("\n=== PHASE 1: Clone via UI ===");
    const cloneBtn = page.locator('button[title="Clone repository"]');
    await cloneBtn.click();

    // Wait for input to appear and fill it
    log("Filling clone URL...");
    const urlInput = page.locator(
      'input[placeholder="git@github.com:user/repo.git"]',
    );
    await urlInput.waitFor({ state: "visible", timeout: 5000 });
    await urlInput.fill(TEST_REPO);
    await urlInput.press("Enter");

    // Wait for clone to complete - watch for the repo to appear
    log("Waiting for clone to complete...");
    await page.waitForFunction(
      (name) => {
        const headings = document.querySelectorAll("h3");
        return Array.from(headings).some((h) => h.textContent?.trim() === name);
      },
      REPO_NAME,
      { timeout: 60000 },
    );

    // Wait for .main worktree to be ready
    await page.waitForTimeout(3000);
    log("Clone complete!\n");

    // Find the input field for the repo
    log("=== PHASE 2: Rapid worktree creation via UI ===");
    log(`Finding worktree input for ${REPO_NAME} repo...`);

    // Find the repo section and its input
    const repoSection = page.locator("h3", { hasText: repoRegex }).first();
    const repoTable = repoSection.locator("xpath=ancestor::table");
    const worktreeInput = repoTable
      .locator('input[placeholder="add worktree"]')
      .first();

    await worktreeInput.waitFor({ state: "visible" });

    // Rapidly submit worktree names
    log(`Firing ${branchesToCreate.length} worktree requests rapidly...\n`);

    const submitTimes: Record<string, number> = {};
    const appearTimes: Record<string, number> = {};

    // Set up mutation observer to detect when worktrees appear
    await page.evaluate(() => {
      (window as any).__worktreeAppearances = {};
      const observer = new MutationObserver(() => {
        document.querySelectorAll("tr").forEach((row) => {
          const text = row.textContent || "";
          const match = text.match(/ui-wt-(\d+)/);
          if (match && !(window as any).__worktreeAppearances[match[0]]) {
            (window as any).__worktreeAppearances[match[0]] = Date.now();
          }
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });

    for (const branch of branchesToCreate) {
      submitTimes[branch] = Date.now();
      log(`Submitting: ${branch}`);
      await worktreeInput.fill(branch);
      await worktreeInput.press("Enter");
      // Small delay to let the request fire, but not wait for completion
      await page.waitForTimeout(100);
    }

    // Wait for all worktrees to complete
    log("\nWaiting for all worktrees to appear...");

    for (const branch of branchesToCreate) {
      try {
        // Wait for the worktree row to appear with the branch name
        await page.waitForSelector(`text="${branch}"`, { timeout: 60000 });
        appearTimes[branch] = Date.now();
        const delay = appearTimes[branch] - submitTimes[branch];
        log(`✓ ${branch} appeared in UI (${delay}ms after submit)`);
      } catch (e) {
        log(`✗ ${branch} did not appear`);
      }
    }

    // Summary of delays
    log("\n=== TIMING SUMMARY ===");
    for (const branch of branchesToCreate) {
      if (submitTimes[branch] && appearTimes[branch]) {
        const delay = appearTimes[branch] - submitTimes[branch];
        log(`${branch}: ${delay}ms delay`);
      }
    }

    // Final state
    log("\n=== FINAL STATE ===");
    await page.waitForTimeout(2000);

    // Count worktrees created
    let createdCount = 0;
    for (const branch of branchesToCreate) {
      const row = repoTable.locator("tr").filter({ hasText: branch });
      if ((await row.count()) > 0) createdCount++;
    }
    log(`Worktrees created: ${createdCount}/${branchesToCreate.length}`);

    // Take screenshot
    await page.screenshot({
      path: "stress-test-ui-result.png",
      fullPage: true,
    });
    log("Screenshot saved to stress-test-ui-result.png");

    log("\n=== TEST COMPLETE ===");

    // Keep browser open for inspection
    log("Browser staying open for 10 seconds for inspection...");
    await page.waitForTimeout(10000);
  } catch (error) {
    log(`ERROR: ${error}`);
    await page.screenshot({ path: "stress-test-ui-error.png", fullPage: true });
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
