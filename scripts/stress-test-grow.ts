#!/usr/bin/env bun
/**
 * Stress test: Import repos via CLI grow command while watching UI
 *
 * 1. Creates seed.jsonl with test repos
 * 2. Opens browser to watch UI
 * 3. Runs `grove grow seed.jsonl`
 * 4. Watches UI populate in real-time
 *
 * Run with: bun scripts/stress-test-grow.ts
 */

import { chromium } from "playwright";
import { spawn } from "child_process";
import { writeFile, rm } from "fs/promises";
import { join } from "path";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const SEED_FILE = "/tmp/stress-test-seed.jsonl";

// Test repos - small repos for fast cloning
const TEST_SEED = [
	{ url: "git@github.com:jgeschwendt/jlg.git", worktrees: ["grow-test-1", "grow-test-2"] },
	{ url: "git@github.com:jgeschwendt/jlg.io.git", worktrees: ["grow-test-a"] },
].map(e => JSON.stringify(e)).join("\n");

function log(msg: string) {
	console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function deleteExistingRepos() {
	log("Checking for existing test repos...");
	const res = await fetch(`${BASE_URL}/api/repositories`);
	const repos = await res.json();

	for (const repo of repos) {
		if (repo.clone_url.includes("jlg.git") || repo.clone_url.includes("jlg.io.git")) {
			log(`Deleting existing repo: ${repo.name}`);
			await fetch(`${BASE_URL}/api/repositories?id=${repo.id}`, { method: "DELETE" });
		}
	}
}

async function main() {
	log("=== STRESS TEST: CLI grow + UI watch ===\n");

	// Clean up existing repos first
	await deleteExistingRepos();
	await new Promise(r => setTimeout(r, 1000));

	// Write seed file
	log(`Writing seed file: ${SEED_FILE}`);
	await writeFile(SEED_FILE, TEST_SEED);
	log(`Seed contains ${TEST_SEED.split("\n").length} repos\n`);

	// Launch browser
	const browser = await chromium.launch({ headless: false });
	const page = await browser.newPage();

	page.on("console", (msg) => {
		if (msg.type() === "error") {
			log(`[CONSOLE ERROR] ${msg.text()}`);
		}
	});

	try {
		// Navigate to app
		log("Opening UI...");
		await page.goto(BASE_URL);
		await page.waitForLoadState("domcontentloaded");
		await page.waitForTimeout(1000);

		// Get initial repo count
		const initialRepos = await page.locator("h3").count();
		log(`Initial repos in UI: ${initialRepos}`);

		// Set up observer for new repos appearing
		const appearTimes: Record<string, number> = {};
		const startTime = Date.now();

		// Watch for repo names appearing
		await page.evaluate(() => {
			(window as any).__repoAppearances = {};
			const observer = new MutationObserver(() => {
				document.querySelectorAll("h3").forEach((h) => {
					const name = h.textContent?.trim();
					if (name && !(window as any).__repoAppearances[name]) {
						(window as any).__repoAppearances[name] = Date.now();
					}
				});
			});
			observer.observe(document.body, { childList: true, subtree: true });
		});

		// Run grove grow command
		log("\n=== Running grove grow ===\n");

		const growProcess = spawn("bun", ["run", "cli/index.tsx", "grow", SEED_FILE], {
			cwd: process.cwd(),
			stdio: ["pipe", "pipe", "pipe"],
		});

		growProcess.stdout?.on("data", (data) => {
			const lines = data.toString().trim().split("\n");
			for (const line of lines) {
				log(`[CLI] ${line}`);
			}
		});

		growProcess.stderr?.on("data", (data) => {
			const lines = data.toString().trim().split("\n");
			for (const line of lines) {
				log(`[CLI ERR] ${line}`);
			}
		});

		// Wait for process to complete
		await new Promise<void>((resolve) => {
			growProcess.on("close", () => resolve());
		});

		log("\n=== CLI grow complete ===\n");

		// Wait a bit for UI to settle
		await page.waitForTimeout(2000);

		// Get final repo count
		const finalRepos = await page.locator("h3").count();
		log(`Final repos in UI: ${finalRepos} (added ${finalRepos - initialRepos})`);

		// Check for our test repos
		const testRepos = ["jlg", "jlg.io"];
		for (const name of testRepos) {
			const visible = await page.locator("h3", { hasText: new RegExp(`^${name}$`) }).isVisible().catch(() => false);
			log(`Repo ${name}: ${visible ? "✓ visible" : "✗ not found"}`);
		}

		// Check for worktrees
		const testWorktrees = ["grow-test-1", "grow-test-2", "grow-test-a"];
		for (const branch of testWorktrees) {
			const visible = await page.locator(`text="${branch}"`).isVisible().catch(() => false);
			log(`Worktree ${branch}: ${visible ? "✓ visible" : "✗ not found"}`);
		}

		// Take screenshot
		await page.screenshot({ path: "stress-test-grow-result.png", fullPage: true });
		log("\nScreenshot saved to stress-test-grow-result.png");

		log("\n=== TEST COMPLETE ===");

		// Keep browser open for inspection
		log("Browser staying open for 5 seconds...");
		await page.waitForTimeout(5000);

	} catch (error) {
		log(`ERROR: ${error}`);
		await page.screenshot({ path: "stress-test-grow-error.png", fullPage: true });
	} finally {
		await browser.close();
		// Cleanup seed file
		await rm(SEED_FILE, { force: true });
	}
}

main().catch(console.error);
