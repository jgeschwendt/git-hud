import { rm } from "fs/promises";
import {
	deleteRepository as dbDeleteRepository,
	getRepository,
	listRepositories as dbListRepositories,
} from "./db";
import { onDbChange, clearProgressByPrefix } from "./state";

export type DeleteResult =
	| { success: true }
	| { success: false; error: string };

export async function deleteRepository(repoId: string): Promise<DeleteResult> {
	try {
		const repo = getRepository(repoId);
		if (!repo) {
			return { success: false, error: "Repository not found" };
		}

		// Delete from database (cascades to worktrees)
		dbDeleteRepository(repoId);

		// Delete directory from disk
		await rm(repo.local_path, { recursive: true, force: true });

		// Clear any progress for this repo (by id) and its worktrees (by path)
		clearProgressByPrefix(repoId);
		clearProgressByPrefix(repo.local_path);
		onDbChange();

		return { success: true };
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : "Unknown error",
		};
	}
}

export function listRepositories() {
	return dbListRepositories();
}
