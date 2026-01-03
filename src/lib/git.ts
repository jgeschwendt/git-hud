import { execa } from 'execa'
import { join, dirname } from 'path'
import { mkdir, symlink, copyFile, readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { minimatch } from 'minimatch'

export type GitResult = {
  success: boolean
  stdout?: string
  stderr?: string
  error?: string
}

export type GitStatus = {
  dirty: boolean
  ahead: number
  behind: number
  head: string | null
  branch: string
  commit_message: string | null
}

async function execGit(args: string[], cwd: string): Promise<GitResult> {
  try {
    const result = await execa('git', args, { cwd, reject: false })
    if (result.exitCode === 0) {
      return { success: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
    } else {
      return {
        success: false,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        error: result.stderr.trim() || `Git command failed with code ${result.exitCode}`
      }
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Create new worktree as sibling directory
 *
 * Smart branch detection:
 * 1. Local branch exists → checkout it
 * 2. Remote branch exists → create local tracking remote
 * 3. Neither exists → create new branch from HEAD
 */
export async function createWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  remote = 'origin'
): Promise<GitResult> {
  try {
    if (existsSync(worktreePath)) {
      return { success: false, error: `Worktree already exists: ${worktreePath}` }
    }

    const remoteRef = `${remote}/${branch}`

    // 1. Check if local branch exists
    const localCheck = await execGit(['rev-parse', '--verify', `refs/heads/${branch}`], repoPath)
    if (localCheck.success) {
      // Local branch exists - just check it out
      const result = await execGit(['worktree', 'add', worktreePath, branch], repoPath)
      if (!result.success) return result

      // Ensure tracking is set up if remote exists
      const remoteCheck = await execGit(['rev-parse', '--verify', `refs/remotes/${remoteRef}`], repoPath)
      if (remoteCheck.success) {
        await execGit(['branch', '--set-upstream-to', remoteRef, branch], worktreePath)
      }

      return { success: true, stdout: worktreePath }
    }

    // 2. Check if remote branch exists
    const remoteCheck = await execGit(['rev-parse', '--verify', `refs/remotes/${remoteRef}`], repoPath)
    if (remoteCheck.success) {
      // Remote branch exists - create local branch tracking it
      const result = await execGit(
        ['worktree', 'add', '--track', '-b', branch, worktreePath, remoteRef],
        repoPath
      )
      return result.success ? { success: true, stdout: worktreePath } : result
    }

    // 3. Neither exists - create new branch from HEAD
    const result = await execGit(['worktree', 'add', '-b', branch, worktreePath], repoPath)
    return result.success ? { success: true, stdout: worktreePath } : result
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * Remove worktree
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string
): Promise<GitResult> {
  try {
    // Remove worktree from git
    const result = await execGit(['worktree', 'remove', worktreePath, '--force'], repoPath)
    return result
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * Get git status for worktree
 */
export async function getGitStatus(worktreePath: string): Promise<GitStatus | null> {
  try {
    // Get current branch
    const branchResult = await execGit(['branch', '--show-current'], worktreePath)
    if (!branchResult.success) return null
    const branch = branchResult.stdout || 'HEAD'

    // Get HEAD commit
    const headResult = await execGit(['rev-parse', 'HEAD'], worktreePath)
    const head = headResult.success ? headResult.stdout || null : null

    // Check if dirty
    const statusResult = await execGit(['status', '--porcelain'], worktreePath)
    const dirty = statusResult.success && statusResult.stdout !== ''

    // Get ahead/behind counts
    let ahead = 0
    let behind = 0

    const revListResult = await execGit(
      ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`],
      worktreePath
    )

    if (revListResult.success && revListResult.stdout) {
      const parts = revListResult.stdout.split(/\s+/)
      behind = parseInt(parts[0]) || 0
      ahead = parseInt(parts[1]) || 0
    }

    // Get commit message
    const messageResult = await execGit(['log', '-1', '--format=%s'], worktreePath)
    const commit_message = messageResult.success ? messageResult.stdout || null : null

    return { dirty, ahead, behind, head, branch, commit_message }
  } catch (err) {
    return null
  }
}

/**
 * Share files between worktrees (symlinks and copies)
 */
export async function shareFiles(
  sourcePath: string,
  targetPath: string,
  symlinkPatterns: string[],
  copyPatterns: string[]
): Promise<GitResult> {
  try {
    const files = await readdir(sourcePath, { recursive: true })

    for (const file of files) {
      const sourceFull = join(sourcePath, file)
      const targetFull = join(targetPath, file)

      // Skip directories and .git
      if (file.includes('.git')) continue

      const fileStat = await stat(sourceFull)
      if (fileStat.isDirectory()) continue

      // Check if matches symlink patterns
      const shouldSymlink = symlinkPatterns.some(pattern => minimatch(file, pattern))
      const shouldCopy = copyPatterns.some(pattern => minimatch(file, pattern))

      if (!shouldSymlink && !shouldCopy) continue

      // Ensure target directory exists
      await mkdir(dirname(targetFull), { recursive: true })

      if (shouldSymlink) {
        // Create symlink
        if (!existsSync(targetFull)) {
          await symlink(sourceFull, targetFull)
        }
      } else if (shouldCopy) {
        // Copy file
        await copyFile(sourceFull, targetFull)
      }
    }

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * Fetch latest from remote
 */
export async function fetch(repoPath: string, remote = 'origin'): Promise<GitResult> {
  return execGit(['fetch', remote], repoPath)
}

/**
 * Pull latest changes
 * If branch has tracking info, uses it. Otherwise pulls from origin explicitly.
 */
export async function pull(worktreePath: string, remote = 'origin'): Promise<GitResult> {
  // Get current branch
  const branchResult = await execGit(['branch', '--show-current'], worktreePath)
  if (!branchResult.success || !branchResult.stdout) {
    return { success: false, error: 'Could not determine current branch' }
  }
  const branch = branchResult.stdout

  // Check if tracking is set up
  const trackingResult = await execGit(
    ['config', '--get', `branch.${branch}.remote`],
    worktreePath
  )

  if (trackingResult.success && trackingResult.stdout) {
    // Has tracking - use regular pull
    return execGit(['pull'], worktreePath)
  }

  // No tracking - pull explicitly from remote
  // Use --ff-only to avoid merge commits when pulling
  return execGit(['pull', '--ff-only', remote, branch], worktreePath)
}
