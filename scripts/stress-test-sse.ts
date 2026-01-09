#!/usr/bin/env bun
/**
 * SSE-based stress test for grow command
 *
 * Connects to SSE stream directly to watch state changes,
 * rather than relying on brittle DOM selectors.
 *
 * Two scenarios:
 * 1. Empty start: No repos, grow seeds 2 repos
 * 2. Existing repo: Start with 1 repo, grow adds another
 *
 * Run: bun scripts/stress-test-sse.ts
 */

import { writeFile, rm } from "fs/promises";
import { spawn } from "child_process";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const SEED_FILE = "/tmp/stress-test-seed.jsonl";

// Small test repos
const TEST_REPOS = [
	{ url: "git@github.com:jgeschwendt/jlg.git", worktrees: ["sse-test-1"] },
	{ url: "git@github.com:jgeschwendt/jlg.io.git", worktrees: ["sse-test-a"] },
];

interface RepoState {
	id: string;
	name: string;
	clone_url: string;
	worktrees?: Array<{ path: string; branch: string; status: string }>;
	progress?: string;
}

interface AppState {
	repositories: RepoState[];
	progress: Record<string, string>;
}

function log(msg: string) {
	console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
}

function logState(state: AppState) {
	log(`State: ${state.repositories.length} repos`);
	for (const repo of state.repositories) {
		const progress = state.progress[repo.id] || "";
		const worktrees = repo.worktrees || [];
		log(`  ${repo.name}: ${worktrees.length} worktrees ${progress ? `[${progress}]` : ""}`);
		for (const wt of worktrees) {
			const wtProgress = state.progress[wt.path] || "";
			log(`    - ${wt.branch}: ${wt.status} ${wtProgress ? `[${wtProgress}]` : ""}`);
		}
	}
}

async function deleteTestRepos() {
	log("Cleaning up existing test repos...");
	const res = await fetch(`${BASE_URL}/api/repositories`);
	const repos = await res.json();

	// Match by repo name (jlg or jlg.io) to handle different clone URL formats
	for (const repo of repos) {
		if (repo.name === "jlg" || repo.name === "jlg.io") {
			log(`  Deleting: ${repo.name}`);
			await fetch(`${BASE_URL}/api/repositories/${repo.id}`, { method: "DELETE" });
		}
	}
	// Wait for deletions to complete
	await new Promise((r) => setTimeout(r, 2000));
}

async function connectSSE(): Promise<{
	close: () => void;
	waitFor: (predicate: (state: AppState) => boolean, timeout?: number) => Promise<AppState>;
	getCurrentState: () => AppState | null;
}> {
	return new Promise((resolve, reject) => {
		let currentState: AppState | null = null;
		const waiters: Array<{
			predicate: (state: AppState) => boolean;
			resolve: (state: AppState) => void;
			reject: (error: Error) => void;
		}> = [];

		const controller = new AbortController();

		fetch(`${BASE_URL}/api/state`, {
			signal: controller.signal,
			headers: { Accept: "text/event-stream" },
		})
			.then(async (response) => {
				if (!response.ok) {
					reject(new Error(`SSE connection failed: ${response.status}`));
					return;
				}

				const reader = response.body?.getReader();
				if (!reader) {
					reject(new Error("No response body"));
					return;
				}

				const decoder = new TextDecoder();
				let buffer = "";

				// Signal ready after first state
				let resolved = false;

				const processData = (data: string) => {
					try {
						const state = JSON.parse(data) as AppState;
						currentState = state;

						// Check waiters
						for (let i = waiters.length - 1; i >= 0; i--) {
							if (waiters[i].predicate(state)) {
								waiters[i].resolve(state);
								waiters.splice(i, 1);
							}
						}

						if (!resolved) {
							resolved = true;
							resolve({
								close: () => controller.abort(),
								waitFor: (predicate, timeout = 120000) =>
									new Promise((res, rej) => {
										// Check immediately
										if (currentState && predicate(currentState)) {
											res(currentState);
											return;
										}

										const timer = setTimeout(() => {
											const idx = waiters.findIndex((w) => w.resolve === res);
											if (idx >= 0) waiters.splice(idx, 1);
											rej(new Error("Timeout waiting for state"));
										}, timeout);

										waiters.push({
											predicate,
											resolve: (s) => {
												clearTimeout(timer);
												res(s);
											},
											reject: (e) => {
												clearTimeout(timer);
												rej(e);
											},
										});
									}),
								getCurrentState: () => currentState,
							});
						}
					} catch {
						// Ignore parse errors
					}
				};

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });

					// Process complete SSE events
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";

					for (const line of lines) {
						if (line.startsWith("data: ")) {
							processData(line.slice(6));
						}
					}
				}
			})
			.catch((e) => {
				if (e.name !== "AbortError") reject(e);
			});
	});
}

async function runGrow(seedFile: string): Promise<void> {
	log("Running grove grow...");

	return new Promise((resolve, reject) => {
		const proc = spawn("./target/release/grove", ["grow", seedFile], {
			cwd: process.cwd(),
			stdio: ["pipe", "pipe", "pipe"],
		});

		proc.stdout?.on("data", (data) => {
			for (const line of data.toString().trim().split("\n")) {
				log(`[CLI] ${line}`);
			}
		});

		proc.stderr?.on("data", (data) => {
			for (const line of data.toString().trim().split("\n")) {
				log(`[CLI ERR] ${line}`);
			}
		});

		proc.on("error", reject);
		proc.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`grove grow exited with ${code}`));
		});
	});
}

// ─────────────────────────────────────────────────────────────
// Scenario 1: Empty start
// ─────────────────────────────────────────────────────────────

async function scenarioEmptyStart() {
	log("\n═══════════════════════════════════════════");
	log("SCENARIO 1: Empty Start → Grow 2 repos");
	log("═══════════════════════════════════════════\n");

	// Clean up
	await deleteTestRepos();

	// Verify empty
	const res = await fetch(`${BASE_URL}/api/repositories`);
	const repos = await res.json();
	const testRepos = repos.filter(
		(r: any) => r.clone_url.includes("jlg.git") || r.clone_url.includes("jlg.io.git")
	);

	if (testRepos.length > 0) {
		log(`ERROR: Still have ${testRepos.length} test repos after cleanup`);
		return false;
	}

	log("Starting with empty state (no test repos)\n");

	// Connect to SSE
	const sse = await connectSSE();
	log("Connected to SSE stream");
	logState(sse.getCurrentState()!);

	// Write seed file
	await writeFile(SEED_FILE, TEST_REPOS.map((r) => JSON.stringify(r)).join("\n") + "\n");
	log(`\nSeed file ready: ${TEST_REPOS.length} repos to import\n`);

	// Run grow (don't await - watch SSE instead)
	const growPromise = runGrow(SEED_FILE);

	// Watch for first repo to appear
	log("\n--- Waiting for first repo to appear ---");
	const state1 = await sse.waitFor(
		(s) => s.repositories.some((r) => r.clone_url.includes("jlg.git") || r.clone_url.includes("jlg.io.git")),
		60000
	);
	log("First repo appeared!");
	logState(state1);

	// Watch for worktree creation
	log("\n--- Waiting for worktrees to start creating ---");
	const state2 = await sse.waitFor(
		(s) =>
			s.repositories.some(
				(r) =>
					r.worktrees &&
					r.worktrees.some((wt) => wt.branch.startsWith("sse-test") || wt.branch.startsWith("grow-test"))
			),
		120000
	);
	log("Worktree creation started!");
	logState(state2);

	// Wait for grow to finish
	await growPromise;
	log("\nGrow command completed");

	// Wait for all worktrees to be ready
	log("\n--- Waiting for all worktrees to be ready ---");
	const finalState = await sse.waitFor(
		(s) => {
			for (const repo of s.repositories) {
				if (!repo.clone_url.includes("jlg.git") && !repo.clone_url.includes("jlg.io.git")) continue;
				if (!repo.worktrees || repo.worktrees.length === 0) return false;
				if (repo.worktrees.some((wt) => wt.status !== "ready")) return false;
			}
			return s.repositories.some(
				(r) => r.clone_url.includes("jlg.git") || r.clone_url.includes("jlg.io.git")
			);
		},
		120000
	);

	log("\n=== FINAL STATE ===");
	logState(finalState);

	sse.close();

	// Verify results
	const jlg = finalState.repositories.find((r) => r.name === "jlg");
	const jlgIo = finalState.repositories.find((r) => r.name === "jlg.io");

	const results = [
		{ name: "jlg repo exists", pass: !!jlg },
		{ name: "jlg.io repo exists", pass: !!jlgIo },
		{
			name: "jlg has .main worktree",
			pass: jlg?.worktrees?.some((wt) => wt.path.endsWith("/.main")),
		},
		{
			name: "jlg.io has .main worktree",
			pass: jlgIo?.worktrees?.some((wt) => wt.path.endsWith("/.main")),
		},
		{
			name: "jlg.io has sse-test-a worktree",
			pass: jlgIo?.worktrees?.some((wt) => wt.branch === "sse-test-a"),
		},
	];

	log("\n=== RESULTS ===");
	for (const r of results) {
		log(`${r.pass ? "✓" : "✗"} ${r.name}`);
	}

	return results.every((r) => r.pass);
}

// ─────────────────────────────────────────────────────────────
// Scenario 2: Existing repo
// ─────────────────────────────────────────────────────────────

async function scenarioExistingRepo() {
	log("\n═══════════════════════════════════════════");
	log("SCENARIO 2: Grow skips existing repo, clones new one");
	log("═══════════════════════════════════════════\n");

	// Clean up
	await deleteTestRepos();
	await new Promise((r) => setTimeout(r, 1000));

	// Clone first repo directly via API (jlg.io will be skipped by grow)
	log("Setting up: Clone jlg.io first...");
	const cloneRes = await fetch(`${BASE_URL}/api/clone`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ url: "git@github.com:jgeschwendt/jlg.io.git" }),
	});
	const cloneBody = await cloneRes.json();
	if (!cloneBody.ok) {
		log(`ERROR: Clone failed: ${cloneBody.error}`);
		return false;
	}

	// Connect to SSE and wait for clone to complete
	const sse = await connectSSE();
	log("Connected to SSE, waiting for initial clone to complete...");

	await sse.waitFor(
		(s) => {
			const repo = s.repositories.find((r) => r.name === "jlg.io");
			if (!repo) return false;
			if (!repo.worktrees || repo.worktrees.length === 0) return false;
			return repo.worktrees.every((wt) => wt.status === "ready");
		},
		120000
	);

	log("Initial clone complete!");
	logState(sse.getCurrentState()!);

	// grow should skip jlg.io (already exists) and clone jlg (new)
	log("\n--- Running grow with existing repo ---\n");

	await writeFile(SEED_FILE, TEST_REPOS.map((r) => JSON.stringify(r)).join("\n") + "\n");
	await runGrow(SEED_FILE);

	// Wait for jlg to be fully ready (jlg.io unchanged)
	log("\n--- Waiting for grow to complete ---");
	await sse.waitFor(
		(s) => {
			// jlg repo should exist with worktrees ready
			const jlg = s.repositories.find((r) => r.name === "jlg");
			if (!jlg || !jlg.worktrees || jlg.worktrees.length === 0) return false;
			return jlg.worktrees.every((wt) => wt.status === "ready");
		},
		180000
	);

	log("\n=== FINAL STATE ===");
	logState(sse.getCurrentState()!);

	sse.close();

	const finalState = sse.getCurrentState()!;
	const jlg = finalState.repositories.find((r) => r.name === "jlg");
	const jlgIo = finalState.repositories.find((r) => r.name === "jlg.io");

	const results = [
		{ name: "jlg cloned (wasn't skipped)", pass: !!jlg },
		{
			name: "jlg has .main worktree",
			pass: jlg?.worktrees?.some((wt) => wt.path.endsWith("/.main")),
		},
		{
			name: "jlg has sse-test-1 worktree",
			pass: jlg?.worktrees?.some((wt) => wt.branch === "sse-test-1"),
		},
		{
			name: "jlg.io unchanged (no new worktrees)",
			pass: jlgIo?.worktrees?.length === 1 && jlgIo.worktrees[0].path.endsWith("/.main"),
		},
	];

	log("\n=== RESULTS ===");
	for (const r of results) {
		log(`${r.pass ? "✓" : "✗"} ${r.name}`);
	}

	return results.every((r) => r.pass);
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
	log("═══════════════════════════════════════════════════════════");
	log("         SSE STRESS TEST FOR GROVE GROW");
	log("═══════════════════════════════════════════════════════════\n");

	try {
		// Verify server is running
		const healthRes = await fetch(`${BASE_URL}/api/repositories`).catch(() => null);
		if (!healthRes) {
			log("ERROR: Server not running at " + BASE_URL);
			log("Start with: ./target/release/grove server");
			process.exit(1);
		}

		const scenario = process.argv[2];

		if (scenario === "1" || scenario === "empty") {
			const pass = await scenarioEmptyStart();
			process.exit(pass ? 0 : 1);
		} else if (scenario === "2" || scenario === "existing") {
			const pass = await scenarioExistingRepo();
			process.exit(pass ? 0 : 1);
		} else {
			// Run both
			const pass1 = await scenarioEmptyStart();
			const pass2 = await scenarioExistingRepo();

			log("\n═══════════════════════════════════════════════════════════");
			log("                    SUMMARY");
			log("═══════════════════════════════════════════════════════════");
			log(`Scenario 1 (Empty Start):     ${pass1 ? "PASS ✓" : "FAIL ✗"}`);
			log(`Scenario 2 (Existing Repo):   ${pass2 ? "PASS ✓" : "FAIL ✗"}`);
			log("═══════════════════════════════════════════════════════════\n");

			process.exit(pass1 && pass2 ? 0 : 1);
		}
	} finally {
		await rm(SEED_FILE, { force: true }).catch(() => {});
	}
}

main().catch((e) => {
	log(`FATAL: ${e}`);
	process.exit(1);
});
