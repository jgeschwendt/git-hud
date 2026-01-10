export interface Worktree {
  path: string;
  repo_id: string;
  branch: string;
  head: string | null;
  status: "creating" | "ready" | "error" | "deleting";
  commit_message: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  last_status_check: number | null;
  created_at: number;
  deleted_at: number | null;
}

export interface Repository {
  id: string;
  provider: string;
  username: string;
  name: string;
  clone_url: string;
  local_path: string;
  type: string | null;
  default_branch: string;
  last_synced: number;
  created_at: number;
  deleted_at: number | null;
}
