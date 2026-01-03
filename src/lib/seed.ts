/**
 * Seed file operations for grove
 *
 * harvest: Export current repos/worktrees to seed.jsonl
 * grow: Import repos/worktrees from seed.jsonl
 *
 * Format: JSON Lines (one JSON object per line)
 */

import { listRepositories, getWorktreeConfig, listWorktrees } from "./db";
import { cloneRepository } from "./clone";
import { createWorktree } from "./worktree";
import type { WorktreeConfig } from "./types";

export type SeedEntry = {
	url: string;
	worktrees?: string[];
	config?: {
		symlink_patterns: string;
		copy_patterns: string;
	};
};

/**
 * Export all repositories to JSONL format
 * Each line is a SeedEntry
 */
export function harvest(): string {
	const repos = listRepositories();
	const lines: string[] = [];

	for (const repo of repos) {
		const worktrees = listWorktrees(repo.id)
			.filter((wt) => !wt.path.endsWith("/.main"))
			.map((wt) => wt.branch);

		const config = getWorktreeConfig(repo.id);

		const entry: SeedEntry = {
			url: repo.clone_url,
		};

		if (worktrees.length > 0) {
			entry.worktrees = worktrees;
		}

		if (config && (config.symlink_patterns || config.copy_patterns)) {
			entry.config = {
				symlink_patterns: config.symlink_patterns,
				copy_patterns: config.copy_patterns,
			};
		}

		lines.push(JSON.stringify(entry));
	}

	return lines.join("\n");
}

export type GrowResult = {
	url: string;
	success: boolean;
	repoId?: string;
	error?: string;
	worktrees: { branch: string; success: boolean; error?: string }[];
};

export type GrowProgress = {
	type: "repo_start" | "repo_done" | "worktree_start" | "worktree_done";
	url?: string;
	branch?: string;
	success?: boolean;
	error?: string;
	current: number;
	total: number;
};

/**
 * Import repositories from JSONL format
 * Clones repos and creates worktrees
 */
export async function grow(
	content: string,
	onProgress?: (progress: GrowProgress) => void,
): Promise<GrowResult[]> {
	const lines = content
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);

	const entries: SeedEntry[] = [];

	for (const line of lines) {
		try {
			entries.push(JSON.parse(line));
		} catch {
			// Skip invalid lines
		}
	}

	const results: GrowResult[] = [];
	const total = entries.length;

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const current = i + 1;

		onProgress?.({
			type: "repo_start",
			url: entry.url,
			current,
			total,
		});

		const result: GrowResult = {
			url: entry.url,
			success: false,
			worktrees: [],
		};

		// Clone the repository
		const cloneResult = await cloneRepository(entry.url);

		if (!cloneResult.success) {
			result.error = cloneResult.error;
			onProgress?.({
				type: "repo_done",
				url: entry.url,
				success: false,
				error: cloneResult.error,
				current,
				total,
			});
			results.push(result);
			continue;
		}

		result.success = true;
		result.repoId = cloneResult.repoId;

		onProgress?.({
			type: "repo_done",
			url: entry.url,
			success: true,
			current,
			total,
		});

		// Create worktrees if specified
		if (entry.worktrees && entry.worktrees.length > 0) {
			for (const branch of entry.worktrees) {
				onProgress?.({
					type: "worktree_start",
					url: entry.url,
					branch,
					current,
					total,
				});

				const wtResult = await createWorktree(cloneResult.repoId, branch);

				result.worktrees.push({
					branch,
					success: wtResult.success,
					error: wtResult.success ? undefined : wtResult.error,
				});

				onProgress?.({
					type: "worktree_done",
					url: entry.url,
					branch,
					success: wtResult.success,
					error: wtResult.success ? undefined : wtResult.error,
					current,
					total,
				});
			}
		}

		results.push(result);
	}

	return results;
}
