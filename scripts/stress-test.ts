#!/usr/bin/env bun
/**
 * Stress test: Clone repo then rapidly add 5 worktrees
 * Run with: bun scripts/stress-test.ts
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const TEST_REPO = "git@github.com:jgeschwendt/grove.git";

function log(msg: string) {
	console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function deleteRepo(repoId: string) {
	log(`Deleting repo ${repoId}...`);
	const res = await fetch(`${BASE_URL}/api/repositories?id=${repoId}`, {
		method: "DELETE",
	});
	const data = await res.json();
	log(`Delete result: ${JSON.stringify(data)}`);
	return data;
}

async function cloneRepo(url: string): Promise<string | null> {
	log(`Cloning ${url}...`);

	const res = await fetch(`${BASE_URL}/api/clone`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ url }),
	});

	// Read SSE stream for clone progress
	const reader = res.body?.getReader();
	if (!reader) {
		log("No response body");
		return null;
	}

	const decoder = new TextDecoder();
	let repoId: string | null = null;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		const chunk = decoder.decode(value);
		const lines = chunk.split("\n");

		for (const line of lines) {
			if (line.startsWith("data: ")) {
				const data = line.slice(6);
				try {
					const parsed = JSON.parse(data);
					if (parsed.done && parsed.repoId) {
						repoId = parsed.repoId;
						log(`Clone complete, repoId: ${repoId}`);
					} else if (parsed.progress) {
						log(`Clone: ${parsed.progress}`);
					} else if (parsed.error) {
						log(`Clone ERROR: ${parsed.error}`);
					}
				} catch {
					log(`Clone raw: ${data}`);
				}
			}
		}
	}

	return repoId;
}

async function createWorktree(repoId: string, branch: string): Promise<void> {
	log(`Creating worktree: ${branch}`);

	const res = await fetch(`${BASE_URL}/api/worktree`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ repo_id: repoId, branch }),
	});

	// Read SSE stream for worktree progress
	const reader = res.body?.getReader();
	if (!reader) {
		log(`[${branch}] No response body`);
		return;
	}

	const decoder = new TextDecoder();

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		const chunk = decoder.decode(value);
		const lines = chunk.split("\n");

		for (const line of lines) {
			if (line.startsWith("data: ")) {
				const data = line.slice(6);
				if (data === "[DONE]") {
					log(`[${branch}] Done`);
				} else if (data.startsWith("MAIN:")) {
					log(`[${branch}] MAIN: ${data.slice(5)}`);
				} else if (data.startsWith("WT:")) {
					log(`[${branch}] WT: ${data.slice(3)}`);
				} else if (data.startsWith("ERROR:")) {
					log(`[${branch}] ERROR: ${data.slice(6)}`);
				} else {
					log(`[${branch}] ${data}`);
				}
			}
		}
	}
}

async function main() {
	log("=== STRESS TEST: Clone + 5 rapid worktrees ===\n");

	// First check if repo already exists and delete it
	log("Checking for existing repo...");
	const listRes = await fetch(`${BASE_URL}/api/repositories`);
	const repos = await listRes.json();

	const existing = repos.find((r: any) => r.clone_url === TEST_REPO);
	if (existing) {
		log(`Found existing repo: ${existing.id}`);
		await deleteRepo(existing.id);
		await new Promise(r => setTimeout(r, 1000)); // Wait for cleanup
	}

	// Clone the repo
	log("\n=== PHASE 1: Clone ===");
	const repoId = await cloneRepo(TEST_REPO);

	if (!repoId) {
		log("Failed to get repoId from clone");
		process.exit(1);
	}

	log(`\nClone complete. RepoId: ${repoId}`);
	log("\n=== PHASE 2: Rapid worktree creation ===");
	log("Firing 5 worktree requests simultaneously...\n");

	// Fire 5 worktree requests simultaneously
	const branches = ["wt-1", "wt-2", "wt-3", "wt-4", "wt-5"];

	const promises = branches.map(branch => createWorktree(repoId, branch));

	await Promise.all(promises);

	log("\n=== TEST COMPLETE ===");

	// Final state check
	log("\nFetching final repository state...");
	const finalRes = await fetch(`${BASE_URL}/api/repositories`);
	const finalRepos = await finalRes.json();
	const testRepo = finalRepos.find((r: any) => r.id === repoId);

	if (testRepo) {
		log(`\nRepository: ${testRepo.name}`);
		log(`Worktrees: ${testRepo.worktrees?.length || 0}`);
		for (const wt of testRepo.worktrees || []) {
			log(`  - ${wt.branch}: status=${wt.status}, head=${wt.head?.slice(0, 7) || 'null'}`);
		}
	}
}

main().catch(console.error);
