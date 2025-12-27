'use server'

import { join } from 'path'
import { rm } from 'fs/promises'
import {
  insertRepository,
  insertWorktree,
  listRepositories,
  listWorktrees,
  getRepository,
  getWorktree,
  updateWorktreeStatus,
  updateWorktreeGitStatus,
  deleteWorktree as dbDeleteWorktree,
  deleteRepository as dbDeleteRepository,
  upsertWorktreeConfig,
  getWorktreeConfig
} from '@/lib/db'
import {
  cloneBare,
  createWorktree as gitCreateWorktree,
  removeWorktree,
  getGitStatus,
  shareFiles
} from '@/lib/git'
import type { ApiResponse, Repository, Worktree } from '@/lib/types'

const GIT_HUD_ROOT = process.env.GIT_HUD_ROOT || join(process.env.HOME!, '.git-hud')
const CLONES_DIR = join(GIT_HUD_ROOT, 'clones')

/**
 * Parse Git URL into provider/username/repo
 */
function parseGitUrl(url: string): { provider: string; username: string; name: string } | null {
  const patterns = [
    /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/,
    /gitlab\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/,
    /bitbucket\.org[:/]([^/]+)\/(.+?)(?:\.git)?$/
  ]

  for (const pattern of patterns) {
    const match = url.match(pattern)
    if (match) {
      const provider = url.includes('gitlab') ? 'gitlab' : url.includes('bitbucket') ? 'bitbucket' : 'github'
      return {
        provider,
        username: match[1],
        name: match[2]
      }
    }
  }

  return null
}

/**
 * Clone repository
 */
export async function cloneRepository(
  url: string,
  defaultBranch = 'main'
): Promise<ApiResponse<{ repo_id: string; path: string }>> {
  try {
    const parsed = parseGitUrl(url)
    if (!parsed) {
      return { success: false, error: 'Invalid Git URL' }
    }

    const { provider, username, name } = parsed
    const localPath = join(CLONES_DIR, provider, username, name)

    // Clone as bare
    const cloneResult = await cloneBare(url, localPath, defaultBranch)
    if (!cloneResult.success) {
      return { success: false, error: cloneResult.error }
    }

    // Insert into database
    const repoId = insertRepository({
      provider,
      username,
      name,
      clone_url: url,
      local_path: localPath,
      type: 'bare',
      last_synced: Date.now()
    })

    // Insert __main__ worktree
    const mainPath = join(localPath, '__main__')
    insertWorktree({
      path: mainPath,
      repo_id: repoId,
      branch: defaultBranch,
      head: null,
      status: 'ready',
      commit_message: null,
      dirty: false,
      ahead: 0,
      behind: 0,
      last_status_check: null,
      vscode_pid: null,
      vscode_opened_at: null
    })

    // Set default worktree config
    upsertWorktreeConfig({
      repo_id: repoId,
      symlink_patterns: '.env,.env.*,.claude/**',
      copy_patterns: '',
      upstream_remote: 'origin'
    })

    return { success: true, data: { repo_id: repoId, path: localPath } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error'
    }
  }
}

/**
 * Create worktree
 */
export async function createWorktree(
  repoId: string,
  branch: string,
  newBranch = false
): Promise<ApiResponse<{ path: string }>> {
  try {
    const repo = getRepository(repoId)
    if (!repo) {
      return { success: false, error: 'Repository not found' }
    }

    // Create worktree
    const result = await gitCreateWorktree(repo.local_path, branch, newBranch)
    if (!result.success) {
      return { success: false, error: result.error }
    }

    const worktreePath = result.stdout!

    // Insert into database
    insertWorktree({
      path: worktreePath,
      repo_id: repoId,
      branch,
      head: null,
      status: 'creating',
      commit_message: null,
      dirty: false,
      ahead: 0,
      behind: 0,
      last_status_check: null,
      vscode_pid: null,
      vscode_opened_at: null
    })

    // Share files from __main__
    const mainPath = join(repo.local_path, '__main__')
    const config = getWorktreeConfig(repoId)

    if (config) {
      const symlinkPatterns = config.symlink_patterns.split(',').filter(Boolean)
      const copyPatterns = config.copy_patterns.split(',').filter(Boolean)

      await shareFiles(mainPath, worktreePath, symlinkPatterns, copyPatterns)
    }

    // Update status to ready
    updateWorktreeStatus(worktreePath, 'ready')

    // Update git status
    const gitStatus = await getGitStatus(worktreePath)
    if (gitStatus) {
      updateWorktreeGitStatus(worktreePath, gitStatus.dirty, gitStatus.ahead, gitStatus.behind)
      updateWorktreeStatus(worktreePath, 'ready', gitStatus.head ?? undefined)
    }

    return { success: true, data: { path: worktreePath } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error'
    }
  }
}

/**
 * Delete worktree
 */
export async function deleteWorktree(path: string): Promise<ApiResponse> {
  try {
    const worktree = getWorktree(path)
    if (!worktree) {
      return { success: false, error: 'Worktree not found' }
    }

    const repo = getRepository(worktree.repo_id)
    if (!repo) {
      return { success: false, error: 'Repository not found' }
    }

    // Remove from git
    const result = await removeWorktree(repo.local_path, path)
    if (!result.success) {
      return { success: false, error: result.error }
    }

    // Remove from database
    dbDeleteWorktree(path)

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error'
    }
  }
}

/**
 * Refresh worktree git status
 */
export async function refreshWorktreeStatus(path: string): Promise<ApiResponse> {
  try {
    const gitStatus = await getGitStatus(path)
    if (!gitStatus) {
      return { success: false, error: 'Failed to get git status' }
    }

    updateWorktreeGitStatus(path, gitStatus.dirty, gitStatus.ahead, gitStatus.behind)
    updateWorktreeStatus(path, 'ready', gitStatus.head ?? undefined)

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error'
    }
  }
}

/**
 * Get all repositories
 */
export async function getRepositories(): Promise<ApiResponse<Repository[]>> {
  try {
    const repos = listRepositories()
    return { success: true, data: repos }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error'
    }
  }
}

/**
 * Get worktrees for repository
 */
export async function getWorktrees(repoId: string): Promise<ApiResponse<Worktree[]>> {
  try {
    const worktrees = listWorktrees(repoId)
    return { success: true, data: worktrees }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error'
    }
  }
}

/**
 * Delete repository
 */
export async function deleteRepository(repoId: string): Promise<ApiResponse> {
  try {
    const repo = getRepository(repoId)
    if (!repo) {
      return { success: false, error: 'Repository not found' }
    }

    // Delete all worktrees first
    const worktrees = listWorktrees(repoId)
    for (const worktree of worktrees) {
      await removeWorktree(repo.local_path, worktree.path)
    }

    // Delete from database (cascades to worktrees)
    dbDeleteRepository(repoId)

    // Delete directory from disk
    await rm(repo.local_path, { recursive: true, force: true })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error'
    }
  }
}
