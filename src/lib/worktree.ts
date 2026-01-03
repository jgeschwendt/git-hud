import { join } from "path";
import { existsSync } from "fs";
import { execa } from "execa";
import {
	getRepository,
	getWorktreeConfig,
	getWorktree,
	insertWorktree,
	listWorktrees as dbListWorktrees,
	deleteWorktree as dbDeleteWorktree,
	updateWorktreeStatus,
	updateWorktreeGitStatus,
	updateRepositorySynced,
} from "./db";
import {
	createWorktree as gitCreateWorktree,
	removeWorktree as gitRemoveWorktree,
	shareFiles,
	getGitStatus,
	fetch,
	pull,
} from "./git";
import { setProgress, onDbChange } from "./state";

// Shared main sync - all concurrent worktree creations wait on the SAME sync
const mainSyncInProgress = new Map<string, Promise<void>>();
const lastSyncedAt = new Map<string, number>();
const SYNC_COOLDOWN_MS = 10000; // 10 seconds - if synced recently, skip

async function ensureMainSynced(
	repoId: string,
	repoPath: string,
	mainPath: string,
): Promise<void> {
	// Check if we synced recently - skip sync entirely if within cooldown
	const lastSync = lastSyncedAt.get(repoId);
	if (lastSync && Date.now() - lastSync < SYNC_COOLDOWN_MS) {
		setProgress(repoId, "Sync cached");
		return;
	}

	// If sync already in progress, wait for it (don't start another)
	const existing = mainSyncInProgress.get(repoId);
	if (existing) {
		setProgress(repoId, "Waiting for sync...");
		await existing;
		return;
	}

	// Start the sync - all other callers will wait on this same promise
	const syncPromise = (async () => {
		setProgress(repoId, "Fetching...");
		const fetchResult = await fetch(repoPath);
		if (!fetchResult.success) {
			setProgress(repoId, `Warning: fetch failed`);
		}

		setProgress(repoId, "Pulling main...");
		const pullResult = await pull(mainPath);
		if (!pullResult.success) {
			setProgress(repoId, `Warning: pull failed`);
		}

		// Install main to warm cache
		const mainPackageManager = detectPackageManager(mainPath);
		if (mainPackageManager) {
			setProgress(repoId, `Installing main (${mainPackageManager})...`);
			const installResult = await runInstall(mainPath, mainPackageManager, repoId);
			if (!installResult.success) {
				setProgress(repoId, `Warning: install failed`);
			}
		}
	})();

	mainSyncInProgress.set(repoId, syncPromise);

	try {
		await syncPromise;
		lastSyncedAt.set(repoId, Date.now());
	} finally {
		mainSyncInProgress.delete(repoId);
	}
}

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export function detectPackageManager(worktreePath: string): PackageManager | null {
	if (existsSync(join(worktreePath, "bun.lock"))) return "bun";
	if (existsSync(join(worktreePath, "bun.lockb"))) return "bun";
	if (existsSync(join(worktreePath, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(worktreePath, "yarn.lock"))) return "yarn";
	if (existsSync(join(worktreePath, "package-lock.json"))) return "npm";
	if (existsSync(join(worktreePath, "package.json"))) return "npm";
	return null;
}

export async function runInstall(
	worktreePath: string,
	packageManager: PackageManager,
	progressKey: string, // repo.id or worktree.path
): Promise<{ success: boolean; error?: string }> {
	try {
		const subprocess = execa(packageManager, ["install"], {
			cwd: worktreePath,
			reject: false,
		});

		subprocess.stdout?.on("data", (data: Buffer) => {
			const lines = data.toString().trim().split("\n");
			const lastLine = lines[lines.length - 1]?.trim();
			if (lastLine) setProgress(progressKey, lastLine);
		});

		subprocess.stderr?.on("data", (data: Buffer) => {
			const lines = data.toString().trim().split("\n");
			const lastLine = lines[lines.length - 1]?.trim();
			if (lastLine) setProgress(progressKey, lastLine);
		});

		const result = await subprocess;
		if (result.exitCode === 0) {
			return { success: true };
		}
		return { success: false, error: `${packageManager} install failed with code ${result.exitCode}` };
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export type WorktreeResult =
	| { success: true; path: string }
	| { success: false; error: string };

/**
 * Create a new worktree for a repository
 * Progress is pushed via state manager - no callbacks needed
 */
export async function createWorktree(
	repoId: string,
	branch: string,
): Promise<WorktreeResult> {
	const repo = getRepository(repoId);
	if (!repo) {
		return { success: false, error: "Repository not found" };
	}

	// Validate branch name
	const trimmedBranch = branch.trim();
	if (!trimmedBranch || /^\.+$/.test(trimmedBranch)) {
		return { success: false, error: "Invalid branch name" };
	}

	// Convert branch name to directory name:
	// - Preserve dots (v1.0.0), underscores (feature_foo)
	// - Use -- for path separators (feature/foo → feature--foo)
	// - Replace .. with __ to prevent any traversal attempts
	const worktreeName = trimmedBranch === repo.default_branch
		? ".main"
		: trimmedBranch
			.replace(/\.\./g, "__")
			.replace(/\//g, "--")
			.replace(/[^a-zA-Z0-9._-]/g, "-");
	const worktreePath = join(repo.local_path, worktreeName);
	const mainPath = join(repo.local_path, ".main");

	// Ensure worktree path is within repo path (defense in depth)
	if (!worktreePath.startsWith(repo.local_path + "/")) {
		return { success: false, error: "Invalid worktree path" };
	}

	try {
		// 1. Check if worktree already exists
		const existing = getWorktree(worktreePath);
		if (existing) {
			return { success: false, error: "Worktree already exists" };
		}

		// 2. Insert worktree in DB (status="creating") - UI sees it immediately via state push
		setProgress(worktreePath, "Queued...");
		insertWorktree({
			path: worktreePath,
			repo_id: repoId,
			branch,
			head: null,
			status: "creating",
			commit_message: null,
			dirty: false,
			ahead: 0,
			behind: 0,
			last_status_check: null,
			vscode_pid: null,
			vscode_opened_at: null,
		});
		onDbChange();

		// 3. Sync main first - all concurrent creations share the SAME sync
		await ensureMainSynced(repoId, repo.local_path, mainPath);

		// 4. Create git worktree (auto-detects local/remote/new branch)
		setProgress(worktreePath, "Creating worktree...");
		const result = await gitCreateWorktree(repo.local_path, worktreePath, branch);
		if (!result.success) {
			dbDeleteWorktree(worktreePath);
			setProgress(worktreePath, null);
			onDbChange();
			return { success: false, error: result.error || "Failed to create worktree" };
		}

		// 5. Share files from .main
		setProgress(worktreePath, "Sharing files...");
		const config = getWorktreeConfig(repoId);
		if (config) {
			const symlinkPatterns = config.symlink_patterns
				? config.symlink_patterns.split(",").map(p => p.trim()).filter(Boolean)
				: [];
			const copyPatterns = config.copy_patterns
				? config.copy_patterns.split(",").map(p => p.trim()).filter(Boolean)
				: [];

			if (symlinkPatterns.length > 0 || copyPatterns.length > 0) {
				await shareFiles(mainPath, worktreePath, symlinkPatterns, copyPatterns);
			}
		}

		// 6. Install dependencies
		const packageManager = detectPackageManager(worktreePath);
		if (packageManager) {
			setProgress(worktreePath, `Installing (${packageManager})...`);
			const installResult = await runInstall(worktreePath, packageManager, worktreePath);
			if (!installResult.success) {
				setProgress(worktreePath, `Warning: install failed`);
			}
		}

		// 7. Get git status and update to ready
		setProgress(worktreePath, "Getting status...");
		const status = await getGitStatus(worktreePath);

		updateWorktreeStatus(
			worktreePath,
			"ready",
			status?.head || undefined,
			status?.commit_message || undefined,
		);
		if (status) {
			updateWorktreeGitStatus(
				worktreePath,
				status.dirty,
				status.ahead,
				status.behind,
			);
		}

		// Clear progress and push final state
		setProgress(worktreePath, null);
		setProgress(repoId, null);
		onDbChange();

		return { success: true, path: worktreePath };
	} catch (error) {
		// Cleanup on error
		try {
			dbDeleteWorktree(worktreePath);
			setProgress(worktreePath, null);
			setProgress(repoId, null);
			onDbChange();
		} catch {}

		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function deleteWorktree(
	repoId: string,
	worktreePath: string,
): Promise<WorktreeResult> {
	const repo = getRepository(repoId);
	if (!repo) {
		return { success: false, error: "Repository not found" };
	}

	try {
		console.log("[deleteWorktree] Starting:", { repoId, worktreePath });

		// Mark as deleting so UI shows pending state
		updateWorktreeStatus(worktreePath, "deleting");
		onDbChange();
		// Wait for debounced push to fire before starting slow operation
		await new Promise((r) => setTimeout(r, 100));

		// Remove from git (slow operation)
		console.log("[deleteWorktree] Calling git remove...");
		const result = await gitRemoveWorktree(repo.local_path, worktreePath);
		console.log("[deleteWorktree] Git result:", result);
		if (!result.success) {
			// Revert status on failure
			updateWorktreeStatus(worktreePath, "ready");
			onDbChange();
			return { success: false, error: result.error || "Failed to remove worktree" };
		}

		// Remove from DB
		console.log("[deleteWorktree] Removing from DB...");
		dbDeleteWorktree(worktreePath);
		onDbChange();
		console.log("[deleteWorktree] Success!");

		return { success: true, path: worktreePath };
	} catch (error) {
		console.error("[deleteWorktree] Exception:", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function listWorktrees(repoId: string) {
	return dbListWorktrees(repoId);
}

export async function refreshWorktrees(repoId: string): Promise<{ success: boolean; updated: number }> {
	const repo = getRepository(repoId);
	if (!repo) {
		return { success: false, updated: 0 };
	}

	setProgress(repoId, "Refreshing...");

	const worktrees = dbListWorktrees(repoId);
	let updated = 0;

	for (const worktree of worktrees) {
		const status = await getGitStatus(worktree.path);
		if (status) {
			updateWorktreeStatus(
				worktree.path,
				"ready",
				status.head || undefined,
				status.commit_message || undefined,
			);
			updateWorktreeGitStatus(
				worktree.path,
				status.dirty,
				status.ahead,
				status.behind,
			);
			updated++;
		}
	}

	// Update repository's last_synced timestamp
	updateRepositorySynced(repoId);

	setProgress(repoId, null);
	onDbChange();

	return { success: true, updated };
}
