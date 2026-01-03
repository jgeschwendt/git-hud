/**
 * Server-side state manager
 *
 * Maintains in-memory progress tracking and pushes full state to clients via SSE.
 * This simplifies the architecture by making the server the single source of truth.
 */

import { listRepositories as dbListRepositories, listWorktrees } from "./db";
import type { Repository, Worktree } from "./types";

// In-memory progress tracking: path -> message
// Keys can be repo.id (for main/header progress) or worktree.path (for row progress)
const progress = new Map<string, string>();

// SSE listeners - functions that receive state pushes
type StateListener = (state: FullState) => void;
const listeners = new Set<StateListener>();

export type RepoWithWorktrees = Repository & { worktrees: Worktree[] };

export type FullState = {
	repositories: RepoWithWorktrees[];
	progress: Record<string, string>;
};

/**
 * Get current full state for clients
 */
export function getFullState(): FullState {
	const repositories = dbListRepositories();
	const reposWithWorktrees = repositories.map((repo) => ({
		...repo,
		worktrees: listWorktrees(repo.id),
	}));

	return {
		repositories: reposWithWorktrees,
		progress: Object.fromEntries(progress),
	};
}

/**
 * Set progress message for a path (repo.id or worktree.path)
 * Pass null to clear progress
 */
export function setProgress(path: string, message: string | null): void {
	if (message) {
		progress.set(path, message);
	} else {
		progress.delete(path);
	}
	pushState();
}

// Debounce state pushes to coalesce rapid changes
let pushTimeout: ReturnType<typeof setTimeout> | null = null;
const PUSH_DEBOUNCE_MS = 50;

/**
 * Push current state to all connected clients
 * Debounced to coalesce rapid changes (e.g., multiple worktrees updating)
 */
export function pushState(): void {
	if (pushTimeout) clearTimeout(pushTimeout);
	pushTimeout = setTimeout(() => {
		const state = getFullState();
		for (const listener of listeners) {
			try {
				listener(state);
			} catch {
				// Listener may have disconnected
			}
		}
	}, PUSH_DEBOUNCE_MS);
}

/**
 * Subscribe to state changes (for SSE connections)
 * Returns unsubscribe function
 */
export function subscribeState(listener: StateListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Call this after any DB mutation to push updated state to clients
 */
export function onDbChange(): void {
	pushState();
}
