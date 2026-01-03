// Database table types

export type Repository = {
  id: string
  provider: string
  username: string
  name: string
  clone_url: string
  local_path: string
  type: string | null
  default_branch: string
  last_synced: number
  created_at: number
}

export type Worktree = {
  path: string
  repo_id: string
  branch: string
  head: string | null
  status: 'creating' | 'ready' | 'error' | 'deleting'
  commit_message: string | null
  created_at: number
  dirty: boolean
  ahead: number
  behind: number
  last_status_check: number | null
  vscode_pid: number | null
  vscode_opened_at: number | null
}

export type Remote = {
  id: number
  repo_id: string
  name: string
  url: string
  created_at: number
}

export type WorktreeConfig = {
  repo_id: string
  symlink_patterns: string
  copy_patterns: string
  upstream_remote: string
  created_at: number
  updated_at: number
}

// API response types

export type ApiResponse<T = void> = {
  success: boolean
  data?: T
  error?: string
}
