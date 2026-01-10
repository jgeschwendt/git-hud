import type { Repository, Worktree } from "./types";

export interface RepoWithWorktrees extends Repository {
  worktrees: Worktree[];
}

export interface FullState {
  repositories: RepoWithWorktrees[];
  progress: Record<string, string>;
}
