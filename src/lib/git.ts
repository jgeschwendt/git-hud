import { spawn } from 'child_process'
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
}

async function execGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd })
    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr?.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, stdout: stdout.trim(), stderr: stderr.trim() })
      } else {
        resolve({
          success: false,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          error: stderr.trim() || `Git command failed with code ${code}`
        })
      }
    })

    proc.on('error', (err) => {
      resolve({ success: false, error: err.message })
    })
  })
}

/**
 * Clone repository as bare with worktree setup
 * Creates:
 * - .bare/ directory with bare git repo
 * - .git file pointing to .bare
 * - __main__ worktree
 */
export async function cloneBare(
  url: string,
  localPath: string,
  defaultBranch = 'main'
): Promise<GitResult> {
  try {
    // Create parent directory
    await mkdir(localPath, { recursive: true })

    const barePath = join(localPath, '.bare')

    // 1. Clone as bare
    let result = await execGit(['clone', '--bare', url, barePath], localPath)
    if (!result.success) return result

    // 2. Create .git file pointing to bare repo
    const gitFile = join(localPath, '.git')
    await Bun.write(gitFile, 'gitdir: ./.bare\n')

    // 3. Configure remote fetch to get all branches
    result = await execGit(
      ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
      localPath
    )
    if (!result.success) return result

    // 4. Fetch all branches
    result = await execGit(['fetch', 'origin'], localPath)
    if (!result.success) return result

    // 5. Create __main__ worktree
    const mainPath = join(localPath, '__main__')
    result = await execGit(['worktree', 'add', mainPath, defaultBranch], localPath)
    if (!result.success) return result

    return { success: true, stdout: `Cloned to ${localPath}` }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * Create new worktree as sibling directory
 */
export async function createWorktree(
  repoPath: string,
  branch: string,
  newBranch = false
): Promise<GitResult> {
  try {
    const worktreeName = `__${branch.replace(/[^a-zA-Z0-9-]/g, '-')}__`
    const worktreePath = join(repoPath, worktreeName)

    if (existsSync(worktreePath)) {
      return { success: false, error: `Worktree already exists: ${worktreePath}` }
    }

    const args = ['worktree', 'add']
    if (newBranch) {
      args.push('-b', branch)
    }
    args.push(worktreePath)
    if (!newBranch) {
      args.push(branch)
    }

    const result = await execGit(args, repoPath)
    if (!result.success) return result

    return { success: true, stdout: worktreePath }
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

    return { dirty, ahead, behind, head, branch }
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
 * List all worktrees for repository
 */
export async function listWorktreesGit(repoPath: string): Promise<string[]> {
  const result = await execGit(['worktree', 'list', '--porcelain'], repoPath)
  if (!result.success || !result.stdout) return []

  const paths: string[] = []
  const lines = result.stdout.split('\n')

  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      paths.push(line.substring('worktree '.length))
    }
  }

  return paths
}

/**
 * Fetch latest from remote
 */
export async function fetch(repoPath: string, remote = 'origin'): Promise<GitResult> {
  return execGit(['fetch', remote], repoPath)
}

/**
 * Pull latest changes
 */
export async function pull(worktreePath: string): Promise<GitResult> {
  return execGit(['pull'], worktreePath)
}
