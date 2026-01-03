import { listRepositories } from "@/lib/repository";
import { listWorktrees } from "@/lib/worktree";
import { RepositoryTable } from "./repository-table";
import type { RepoWithWorktrees } from "@/lib/state";

export async function RepositoriesLoader() {
  const repositories = listRepositories();
  const reposWithWorktrees: RepoWithWorktrees[] = repositories.map((repo) => ({
    ...repo,
    worktrees: listWorktrees(repo.id),
  }));
  return <RepositoryTable initialRepositories={reposWithWorktrees} />;
}
