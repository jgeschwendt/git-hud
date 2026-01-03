"use client";

import React, { useState, useMemo, useEffect } from "react";
import {
  TrashIcon,
  CodeBracketIcon,
  CommandLineIcon,
  ArrowPathIcon,
  ClockIcon,
} from "@heroicons/react/24/outline";
import type { Worktree } from "@/lib/types";
import type { RepoWithWorktrees, FullState } from "@/lib/state";
import { parseGitUrl } from "@/lib/parse-git-url";
import { EmptyState } from "./empty-state";

type GroupedRepos = Map<string, RepoWithWorktrees[]>;

function groupByUsername(repositories: RepoWithWorktrees[]): GroupedRepos {
  const groups: GroupedRepos = new Map();

  for (const repo of repositories) {
    const username = repo.username;
    if (!groups.has(username)) {
      groups.set(username, []);
    }
    groups.get(username)!.push(repo);
  }

  for (const repos of groups.values()) {
    repos.sort((a, b) => a.name.localeCompare(b.name));
  }

  return groups;
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function sortWorktrees(worktrees: Worktree[]): Worktree[] {
  return [...worktrees].sort((a, b) => {
    if (a.path.endsWith(".main")) return -1;
    if (b.path.endsWith(".main")) return 1;
    const nameA = a.path.split("/").pop() || "";
    const nameB = b.path.split("/").pop() || "";
    return nameA.localeCompare(nameB);
  });
}

// Fire-and-forget mutations - server pushes state updates via SSE
const api = {
  createWorktree: (repoId: string, branch: string) => {
    fetch("/api/worktree", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo_id: repoId, branch }),
    });
  },

  deleteWorktree: (repoId: string, path: string) => {
    fetch(
      `/api/worktree?repo_id=${encodeURIComponent(repoId)}&path=${encodeURIComponent(path)}`,
      {
        method: "DELETE",
      },
    );
  },

  deleteRepository: (repoId: string) => {
    fetch(`/api/repositories?id=${encodeURIComponent(repoId)}`, {
      method: "DELETE",
    });
  },

  cloneRepository: (url: string) => {
    fetch("/api/clone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
  },

  refreshRepository: (repoId: string) => {
    fetch("/api/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo_id: repoId }),
    });
  },

  openPath: (path: string, app: "vscode" | "terminal") => {
    fetch("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, app }),
    });
  },
};

interface RepositoryTableProps {
  initialRepositories: RepoWithWorktrees[];
}

export function RepositoryTable({ initialRepositories }: RepositoryTableProps) {
  const [state, setState] = useState<FullState>({
    repositories: initialRepositories,
    progress: {},
  });

  const [worktreeInputs, setWorktreeInputs] = useState<Map<string, string>>(
    new Map(),
  );

  // Single SSE connection - receives full state on every change
  useEffect(() => {
    const eventSource = new EventSource("/api/state");

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as FullState;
        // Debug: log progress changes
        // if (Object.keys(data.progress).length > 0) {
        // 	console.log("[SSE] progress:", data.progress);
        // }
        setState(data);
      } catch {}
    };

    eventSource.onerror = () => {
      // Reconnect handled automatically by EventSource
    };

    return () => eventSource.close();
  }, []);

  // Listen for clone events from header
  useEffect(() => {
    const handleClone = (e: Event) => {
      const url = (e as CustomEvent).detail?.url;
      if (url) {
        const parsed = parseGitUrl(url);
        if (!parsed) {
          alert("Invalid git URL");
          return;
        }
        api.cloneRepository(url);
      }
    };

    window.addEventListener("grove:clone", handleClone);
    return () => window.removeEventListener("grove:clone", handleClone);
  }, []);

  const groupedRepos = useMemo(
    () => groupByUsername(state.repositories),
    [state.repositories],
  );

  const handleAddWorktree = (e: React.FormEvent, repo: RepoWithWorktrees) => {
    e.preventDefault();
    const branch = worktreeInputs.get(repo.id)?.trim();
    if (!branch) return;

    setWorktreeInputs((prev) => {
      const next = new Map(prev);
      next.delete(repo.id);
      return next;
    });

    api.createWorktree(repo.id, branch);
  };

  const handleDelete = (repoId: string) => {
    if (!confirm("Delete this repository and all its worktrees?")) return;
    api.deleteRepository(repoId);
  };

  const handleDeleteWorktree = (repoId: string, path: string) => {
    if (!confirm("Delete this worktree?")) return;
    api.deleteWorktree(repoId, path);
  };

  if (groupedRepos.size === 0) {
    return <EmptyState onClone={api.cloneRepository} />;
  }

  return (
    <div className="container mx-auto h-full overflow-y-auto">
      <div className="w-full px-5 pb-10">
        <table className="w-full bg-transparent">
          <colgroup>
            <col style={{ width: "1%" }} />
            <col style={{ width: "1%" }} />
            <col style={{ width: "1%" }} />
            <col style={{ width: "1%" }} />
            <col style={{ width: "1%" }} />
            <col style={{ width: "auto" }} />
            <col style={{ width: "1%" }} />
          </colgroup>
          <tbody>
            {Array.from(groupedRepos.entries()).map(([username, repos]) => (
              <React.Fragment key={username}>
                <tr>
                  <td
                    colSpan={7}
                    className="border-b-2 border-black/10 p-4 dark:border-white/10"
                  >
                    <h2 className="font-bold opacity-80">{username}</h2>
                  </td>
                </tr>

                {repos.map((repo) => {
                  const repoProgress = state.progress[repo.id];
                  const isRepoDeleting = repoProgress?.startsWith("Deleting");
                  const allWorktrees = sortWorktrees(repo.worktrees || []);
                  const mainWorktree = allWorktrees.find((wt) =>
                    wt.path.endsWith("/.main"),
                  );
                  const featureWorktrees = allWorktrees.filter(
                    (wt) => !wt.path.endsWith("/.main"),
                  );
                  const inputValue = worktreeInputs.get(repo.id) || "";
                  const mainPath =
                    mainWorktree?.path || `${repo.local_path}/.main`;

                  return (
                    <React.Fragment key={repo.id}>
                      {/* Repository header row */}
                      <tr
                        className={`hover:bg-black/5 dark:hover:bg-white/5 ${isRepoDeleting ? "pointer-events-none opacity-40" : ""}`}
                      >
                        <td colSpan={7} className="py-3">
                          <div className="flex items-center justify-between gap-4">
                            <div className="flex min-w-0 flex-1 items-center gap-3 px-4">
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <h3 className="truncate text-xs font-semibold">
                                    {repo.name}
                                  </h3>
                                  {repo.type && (
                                    <span className="rounded bg-black/10 px-2 py-0.5 text-xs dark:bg-white/10">
                                      {repo.type}
                                    </span>
                                  )}
                                  <span className="truncate font-mono text-xs text-black/50 dark:text-white/50">
                                    {repo.clone_url}
                                  </span>
                                  {mainWorktree ? (
                                    <span className="flex items-center gap-1 font-mono text-xs text-black/50 dark:text-white/50">
                                      <span className="text-black/30 dark:text-white/30">
                                        /
                                      </span>
                                      {mainWorktree.status === "creating" ? (
                                        <span className="text-blue-500">
                                          creating...
                                        </span>
                                      ) : (
                                        <>
                                          {mainWorktree.dirty && (
                                            <span className="text-amber-500">
                                              ●
                                            </span>
                                          )}
                                          {mainWorktree.head?.slice(0, 7)}
                                          {(mainWorktree.ahead > 0 ||
                                            mainWorktree.behind > 0) && (
                                            <span className="text-[9px]">
                                              {mainWorktree.ahead > 0 && (
                                                <span className="text-green-600">
                                                  ↑{mainWorktree.ahead}
                                                </span>
                                              )}
                                              {mainWorktree.behind > 0 && (
                                                <span className="ml-0.5 text-red-500">
                                                  ↓{mainWorktree.behind}
                                                </span>
                                              )}
                                            </span>
                                          )}
                                        </>
                                      )}
                                      <span className="text-black/30 dark:text-white/30">
                                        /
                                      </span>
                                      <span className="max-w-[200px] truncate">
                                        {repoProgress ||
                                          mainWorktree.commit_message ||
                                          ""}
                                      </span>
                                    </span>
                                  ) : (
                                    repoProgress && (
                                      <span className="font-mono text-xs text-black/50 dark:text-white/50">
                                        <span className="text-black/30 dark:text-white/30">
                                          /
                                        </span>
                                        <span className="ml-1">
                                          {repoProgress}
                                        </span>
                                      </span>
                                    )
                                  )}
                                </div>
                              </div>
                            </div>

                            <div className="flex shrink-0 items-center px-1">
                              <div className="mr-2 flex items-center gap-1.5 text-xs text-black/50 dark:text-white/50">
                                <ClockIcon className="h-3.5 w-3.5" />
                                <span>
                                  {formatRelativeTime(repo.last_synced)}
                                </span>
                              </div>
                              <button
                                onClick={() => api.refreshRepository(repo.id)}
                                className="rounded px-2 py-1 text-xs transition-colors hover:bg-black/10 dark:hover:bg-white/10"
                                title="Sync repository"
                              >
                                <ArrowPathIcon className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() =>
                                  api.openPath(repo.local_path, "vscode")
                                }
                                className="rounded px-2 py-1 text-xs transition-colors hover:bg-black/10 dark:hover:bg-white/10"
                                title="Open root in VS Code"
                              >
                                <CodeBracketIcon className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => api.openPath(mainPath, "vscode")}
                                className="rounded px-2 py-1 text-xs transition-colors hover:bg-black/10 dark:hover:bg-white/10"
                                title="Open .main in VS Code"
                              >
                                <CodeBracketIcon className="h-4 w-4 text-blue-500" />
                              </button>
                              <button
                                onClick={() =>
                                  api.openPath(mainPath, "terminal")
                                }
                                className="rounded px-2 py-1 text-xs transition-colors hover:bg-black/10 dark:hover:bg-white/10"
                                title="Open in Terminal"
                              >
                                <CommandLineIcon className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => handleDelete(repo.id)}
                                className="rounded px-2 py-1 text-xs transition-colors hover:bg-black/10 dark:hover:bg-white/10"
                                title="Delete repository"
                              >
                                <TrashIcon className="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>

                      {/* Worktree input row */}
                      <tr
                        className={`bg-black/5 dark:bg-white/5 ${isRepoDeleting ? "pointer-events-none opacity-40" : ""}`}
                      >
                        <td colSpan={7} className="p-3">
                          <form
                            onSubmit={(e) => handleAddWorktree(e, repo)}
                            className="flex-1"
                          >
                            <input
                              type="text"
                              placeholder="add worktree"
                              className="w-full rounded border border-black/20 bg-transparent px-2.5 py-1.5 text-sm placeholder-black/40 dark:border-white/20 dark:placeholder-white/40"
                              value={inputValue}
                              onChange={(e) =>
                                setWorktreeInputs((prev) =>
                                  new Map(prev).set(repo.id, e.target.value),
                                )
                              }
                            />
                          </form>
                        </td>
                      </tr>

                      {/* Worktree rows */}
                      {featureWorktrees.map((wt) => {
                        const name = wt.path.split("/").pop() || "";
                        const shortHash = wt.head?.slice(0, 7) || "";
                        const wtProgress = state.progress[wt.path];
                        const isCreating = wt.status === "creating";
                        const isDeleting = wt.status === "deleting";
                        const isPending =
                          isCreating || isDeleting || isRepoDeleting;

                        return (
                          <tr
                            key={wt.path}
                            className={`text-[10px] leading-[1.2] hover:bg-black/5 dark:hover:bg-white/5 ${isPending ? "opacity-40" : ""}`}
                          >
                            <td className="p-1 pl-4 whitespace-nowrap text-black/60 dark:text-white/60">
                              {name}
                            </td>
                            <td className="p-1 whitespace-nowrap text-black/30 dark:text-white/30">
                              /
                            </td>
                            <td className="p-1 whitespace-nowrap text-black/60 dark:text-white/60">
                              {wt.branch}
                            </td>
                            <td className="p-1 whitespace-nowrap text-black/30 dark:text-white/30">
                              /
                            </td>
                            <td className="p-1 font-mono whitespace-nowrap text-black/50 dark:text-white/50">
                              {isCreating ? (
                                <span className="text-blue-500">
                                  creating...
                                </span>
                              ) : isDeleting ? (
                                <span className="text-red-500">
                                  deleting...
                                </span>
                              ) : (
                                <>
                                  {wt.dirty && (
                                    <span className="mr-1 text-amber-500">
                                      ●
                                    </span>
                                  )}
                                  {shortHash}
                                  {(wt.ahead > 0 || wt.behind > 0) && (
                                    <span className="ml-2 text-[9px]">
                                      {wt.ahead > 0 && (
                                        <span className="text-green-600">
                                          ↑{wt.ahead}
                                        </span>
                                      )}
                                      {wt.behind > 0 && (
                                        <span className="ml-1 text-red-500">
                                          ↓{wt.behind}
                                        </span>
                                      )}
                                    </span>
                                  )}
                                </>
                              )}
                            </td>
                            <td className="max-w-xs truncate pl-4 whitespace-nowrap text-black/50 dark:text-white/50">
                              {wtProgress || wt.commit_message || ""}
                            </td>
                            <td className="p-1">
                              <div
                                className={`flex items-center ${isPending ? "pointer-events-none" : ""}`}
                              >
                                <button
                                  onClick={() =>
                                    api.openPath(wt.path, "vscode")
                                  }
                                  className="rounded px-2 py-1 text-xs transition-colors hover:bg-black/10 dark:hover:bg-white/10"
                                  title="Open in VS Code"
                                >
                                  <CodeBracketIcon className="h-4 w-4" />
                                </button>
                                <button
                                  onClick={() =>
                                    api.openPath(wt.path, "terminal")
                                  }
                                  className="rounded px-2 py-1 text-xs transition-colors hover:bg-black/10 dark:hover:bg-white/10"
                                  title="Open in Terminal"
                                >
                                  <CommandLineIcon className="h-4 w-4" />
                                </button>
                                <button
                                  onClick={() =>
                                    handleDeleteWorktree(repo.id, wt.path)
                                  }
                                  className="rounded px-2 py-1 text-xs transition-colors hover:bg-black/10 dark:hover:bg-white/10"
                                  title="Delete worktree"
                                >
                                  <TrashIcon className="h-4 w-4" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
