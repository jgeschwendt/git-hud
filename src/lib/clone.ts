import { join } from "path";
import { execa } from "execa";
import { mkdir, rm } from "fs/promises";
import { existsSync } from "fs";
import {
	insertRepository,
	insertWorktree,
	upsertWorktreeConfig,
	getRepositoryByPath,
	deleteRepository,
	updateWorktreeStatus,
	updateWorktreeGitStatus,
} from "./db";
import { getGitStatus } from "./git";
import { detectPackageManager, runInstall } from "./worktree";
import { parseGitUrl } from "./parse-git-url";
import { setProgress, onDbChange } from "./state";

const CLONES_DIR = process.env.GIT_HUD_CODE_DIR || join(process.env.HOME!, "code");

export type CloneResult =
	| { success: true; repoId: string }
	| { success: false; error: string };

async function detectDefaultBranch(repoPath: string): Promise<string | null> {
	try {
		const result = await execa(
			"git",
			["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
			{ cwd: repoPath, reject: false },
		);

		if (result.exitCode === 0 && result.stdout.trim()) {
			return result.stdout.trim().replace("origin/", "");
		}
		return null;
	} catch {
		return null;
	}
}

async function execGitWithProgress(
	args: string[],
	cwd: string,
	progressKey: string,
): Promise<void> {
	const subprocess = execa("git", args, { cwd, reject: false });

	subprocess.stderr?.on("data", (data: Buffer) => {
		const line = data.toString().trim();
		if (line) setProgress(progressKey, line);
	});

	const result = await subprocess;
	if (result.exitCode !== 0) {
		throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout}`);
	}
}

/**
 * Clone a repository as a bare repo with worktree setup
 * Progress is pushed via state manager - no callbacks needed
 */
export async function cloneRepository(url: string): Promise<CloneResult> {
	const parsed = parseGitUrl(url);
	if (!parsed) {
		return { success: false, error: "Invalid Git URL" };
	}

	const { provider, username, name } = parsed;
	const localPath = join(CLONES_DIR, username, name);
	const barePath = join(localPath, ".bare");
	const mainPath = join(localPath, ".main");

	// Use a temporary key for progress until we have a repoId
	const tempProgressKey = `clone:${url}`;
	let repoId: string | null = null;

	try {
		// Check if repository already exists
		const existingRepo = getRepositoryByPath(localPath);
		if (existingRepo) {
			return {
				success: false,
				error: `Repository already exists at ${localPath}. Delete it first.`,
			};
		}

		// Check if directory already exists
		if (existsSync(localPath)) {
			setProgress(tempProgressKey, "Cleaning up existing directory...");
			await rm(localPath, { recursive: true, force: true });
		}

		// Create parent directory
		await mkdir(localPath, { recursive: true });

		// 1. Clone as bare
		setProgress(tempProgressKey, "Cloning repository...");
		await execGitWithProgress(["clone", "--bare", url, barePath], localPath, tempProgressKey);

		// 2. Create .git file pointing to bare repo
		setProgress(tempProgressKey, "Configuring repository...");
		await Bun.write(join(localPath, ".git"), "gitdir: ./.bare\n");

		// 3. Configure remote fetch
		await execa("git", ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], {
			cwd: localPath,
			reject: false,
		});

		// 4. Fetch all branches
		setProgress(tempProgressKey, "Fetching branches...");
		await execGitWithProgress(["fetch", "origin"], localPath, tempProgressKey);

		// 5. Detect default branch
		setProgress(tempProgressKey, "Detecting default branch...");
		const defaultBranch = (await detectDefaultBranch(localPath)) || "main";

		// 6. Insert repo into database - UI sees it immediately via state push
		setProgress(tempProgressKey, "Saving repository...");
		repoId = insertRepository({
			provider,
			username,
			name,
			clone_url: url,
			local_path: localPath,
			type: "bare",
			default_branch: defaultBranch,
			last_synced: Date.now(),
		});

		// Switch progress key to repoId now that we have it
		setProgress(tempProgressKey, null);
		setProgress(repoId, "Creating main worktree...");
		onDbChange();

		// 7. Insert worktree in DB (status="creating")
		insertWorktree({
			path: mainPath,
			repo_id: repoId,
			branch: defaultBranch,
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

		// 8. Create git worktree with tracking
		// Bare clone creates local branches from HEAD - delete to recreate with tracking
		await execa("git", ["branch", "-D", defaultBranch], { cwd: localPath, reject: false });
		await execGitWithProgress(
			["worktree", "add", "--track", "-b", defaultBranch, mainPath, `origin/${defaultBranch}`],
			localPath,
			repoId,
		);

		// 9. Install dependencies for .main
		const packageManager = detectPackageManager(mainPath);
		if (packageManager) {
			setProgress(repoId, `Installing (${packageManager})...`);
			const installResult = await runInstall(mainPath, packageManager, repoId);
			if (!installResult.success) {
				setProgress(repoId, `Warning: install failed`);
			}
		}

		// 10. Get git status and update worktree to ready
		setProgress(repoId, "Getting status...");
		const gitStatus = await getGitStatus(mainPath);

		updateWorktreeStatus(
			mainPath,
			"ready",
			gitStatus?.head || undefined,
			gitStatus?.commit_message || undefined,
		);
		if (gitStatus) {
			updateWorktreeGitStatus(
				mainPath,
				gitStatus.dirty,
				gitStatus.ahead,
				gitStatus.behind,
			);
		}

		// 11. Save configuration
		upsertWorktreeConfig({
			repo_id: repoId,
			symlink_patterns: ".env,.env.*,.claude/**",
			copy_patterns: "",
			upstream_remote: "origin",
		});

		// Clear progress and push final state
		setProgress(repoId, null);
		onDbChange();

		return { success: true, repoId };
	} catch (error) {
		// Clean up on error
		setProgress(tempProgressKey, null);
		if (repoId) {
			setProgress(repoId, null);
			try {
				deleteRepository(repoId);
			} catch {}
		}

		if (existsSync(localPath)) {
			try {
				await rm(localPath, { recursive: true, force: true });
			} catch {}
		}

		onDbChange();

		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
