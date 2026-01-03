import { rm } from "fs/promises";
import {
	deleteRepository as dbDeleteRepository,
	getRepository,
	listRepositories as dbListRepositories,
} from "./db";
import { onDbChange, setProgress } from "./state";

export type DeleteResult =
	| { success: true }
	| { success: false; error: string };

export async function deleteRepository(repoId: string): Promise<DeleteResult> {
	try {
		const repo = getRepository(repoId);
		if (!repo) {
			return { success: false, error: "Repository not found" };
		}

		// Show deleting state in UI before slow operations
		setProgress(repoId, "Deleting...");
		// Wait for debounced push to fire before starting slow operation
		await new Promise((r) => setTimeout(r, 100));

		// Delete directory from disk (slow operation)
		await rm(repo.local_path, { recursive: true, force: true });

		// Delete from database (cascades to worktrees)
		dbDeleteRepository(repoId);

		// Clear progress and push final state
		setProgress(repoId, null);
		onDbChange();

		return { success: true };
	} catch (err) {
		setProgress(repoId, null);
		return {
			success: false,
			error: err instanceof Error ? err.message : "Unknown error",
		};
	}
}

export function listRepositories() {
	return dbListRepositories();
}
