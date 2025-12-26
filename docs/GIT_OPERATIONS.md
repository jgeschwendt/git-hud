# Git Operations

This document details all git workflows used by git-hud.

---

## Repository Cloning

### Bare Clone with __main__ Worktree

**Purpose**: Clone repository in bare format with primary worktree for efficient multi-worktree setup.

**Flow**:
```bash
# 1. Create directory structure
mkdir -p ~/.git-hud/clones/github/{username}/{repo}

# 2. Clone as bare
cd ~/.git-hud/clones/github/{username}/{repo}
git clone --bare {url} .bare/

# 3. Create .git file pointing to bare repo
echo "gitdir: ./.bare" > .git

# 4. Configure remote fetch
git config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"

# 5. Create __main__ worktree
git worktree add __main__ main
# Or fallback: git worktree add __main__ master
```

**Implementation**:
```typescript
async cloneRepository(
  url: string,
  onProgress: ProgressCallback
): Promise<{
  provider: string
  username: string
  repoName: string
  localPath: string
}> {
  // Parse URL to extract components
  const parsed = this.parseGitUrl(url)
  // Example: git@github.com:user/repo.git
  //   → { provider: 'github', username: 'user', repoName: 'repo' }

  const repoPath = path.join(
    process.env.GIT_HUD_ROOT!,
    'clones',
    parsed.provider,
    parsed.username,
    parsed.repoName
  )

  onProgress('Cloning bare repository...')
  await execAsync(`git clone --bare "${url}" .bare`, { cwd: repoPath })

  await Bun.write(path.join(repoPath, '.git'), 'gitdir: ./.bare\n')

  onProgress('Configuring remotes...')
  await execAsync(
    'git config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"',
    { cwd: repoPath }
  )

  onProgress('Creating __main__ worktree...')
  try {
    await execAsync('git worktree add __main__ main', { cwd: repoPath })
  } catch {
    await execAsync('git worktree add __main__ master', { cwd: repoPath })
  }

  return { ...parsed, localPath: repoPath }
}
```

### URL Parsing

Supports both SSH and HTTPS URLs:

```typescript
private parseGitUrl(url: string): {
  provider: string
  username: string
  repoName: string
} {
  // SSH: git@github.com:user/repo.git
  if (url.startsWith('git@')) {
    const match = url.match(/git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/)
    if (match) {
      return {
        provider: match[1].split('.')[0],  // github.com → github
        username: match[2],
        repoName: match[3]
      }
    }
  }

  // HTTPS: https://github.com/user/repo.git
  const match = url.match(/https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/)
  if (match) {
    return {
      provider: match[1].split('.')[0],  // github.com → github
      username: match[2],
      repoName: match[3]
    }
  }

  throw new Error('Invalid git URL')
}
```

---

## Worktree Management

### Creating Worktrees

**Purpose**: Create new worktree from upstream branch with file sharing.

**Flow**:
```bash
# 1. Create worktree from upstream
cd ~/.git-hud/clones/github/{username}/{repo}
git worktree add -B {branch} ../{worktree-name} {upstream}/main

# 2. Setup symlinks (shared files)
ln -s {repo}/__main__/.env ../{worktree-name}/.env
ln -s {repo}/__main__/.claude ../{worktree-name}/.claude

# 3. Setup copies (independent files)
cp {repo}/__main__/.env.example ../{worktree-name}/.env.example

# 4. Install dependencies (uses warm cache)
cd ../{worktree-name}
pnpm install
```

**Implementation**:
```typescript
async createWorktree(
  repoPath: string,
  branch: string,
  upstream: string,
  onProgress: ProgressCallback
): Promise<string> {
  const worktreeName = branch.replace(/\//g, '-')
  const worktreePath = path.join(path.dirname(repoPath), worktreeName)

  onProgress('Creating worktree...')
  await execAsync(
    `git worktree add -B "${branch}" "${worktreePath}" "${upstream}/main"`,
    { cwd: repoPath }
  )

  return worktreePath
}
```

**Branch Strategy**:
- `-B {branch}`: Force-create branch (resets if exists locally)
- `{upstream}/main`: Start from upstream main (not local main)
- Creates local tracking branch automatically

### File Sharing Setup

**Purpose**: Share configuration files across worktrees via symlinks, copy templates independently.

**Implementation**:
```typescript
async setupFiles(
  repoPath: string,
  worktreePath: string,
  config: { symlink?: string[], copy?: string[] },
  onProgress: ProgressCallback
): Promise<void> {
  const mainPath = path.join(repoPath, '__main__')

  // Symlink shared files
  if (config.symlink) {
    for (const pattern of config.symlink) {
      const source = path.join(mainPath, pattern)
      const target = path.join(worktreePath, pattern)

      try {
        await execAsync(`ln -s "${source}" "${target}"`)
        onProgress(`  ✓ Linked ${pattern}`)
      } catch {
        onProgress(`  ⊘ Skipped ${pattern} (not found)`)
      }
    }
  }

  // Copy independent files
  if (config.copy) {
    for (const pattern of config.copy) {
      const source = path.join(mainPath, pattern)
      const target = path.join(worktreePath, pattern)

      try {
        await execAsync(`cp -r "${source}" "${target}"`)
        onProgress(`  ✓ Copied ${pattern}`)
      } catch {
        onProgress(`  ⊘ Skipped ${pattern} (not found)`)
      }
    }
  }
}
```

**Common Patterns**:
- **Symlink**: `.env`, `.claude/`, `.vscode/` (shared across all worktrees)
- **Copy**: `.env.example`, `README.md` (independent per worktree)

### Removing Worktrees

**Purpose**: Delete worktree and its local branch.

**Flow**:
```bash
# 1. Remove worktree
git worktree remove --force ../{worktree-name}

# 2. Delete local branch
git branch -D {branch}
```

**Implementation**:
```typescript
async removeWorktree(
  repoPath: string,
  worktreeName: string
): Promise<void> {
  await execAsync(
    `git worktree remove --force "../${worktreeName}"`,
    { cwd: repoPath }
  )

  // Extract branch name from worktree list
  const list = await execAsync('git worktree list --porcelain', { cwd: repoPath })
  const branch = this.extractBranchFromList(list.stdout, worktreeName)

  if (branch) {
    await execAsync(`git branch -D "${branch}"`, { cwd: repoPath })
  }
}
```

---

## Status Tracking

### Git Status Check

**Purpose**: Determine if worktree has uncommitted changes and commit distance from upstream.

**Flow**:
```bash
# 1. Check for uncommitted changes
git status --porcelain
# Empty output = clean, any output = dirty

# 2. Check commits ahead/behind upstream
git rev-list --left-right --count HEAD...@{u}
# Output: "2\t3" = 2 ahead, 3 behind
```

**Implementation**:
```typescript
async getStatus(worktreePath: string): Promise<{
  dirty: boolean
  ahead: number
  behind: number
}> {
  const [porcelain, revList] = await Promise.all([
    execAsync('git status --porcelain', { cwd: worktreePath })
      .then(r => r.stdout),
    execAsync('git rev-list --left-right --count HEAD...@{u}', { cwd: worktreePath })
      .then(r => r.stdout)
      .catch(() => '0\t0')  // No upstream = 0/0
  ])

  const dirty = porcelain.trim().length > 0
  const [ahead, behind] = revList.trim().split('\t').map(Number)

  return { dirty, ahead: ahead || 0, behind: behind || 0 }
}
```

### Listing Worktrees

**Purpose**: Get all worktrees with metadata.

**Flow**:
```bash
git worktree list --porcelain
```

**Output Format**:
```
worktree /path/to/__main__
HEAD abc123...
branch refs/heads/main

worktree /path/to/feature-x
HEAD def456...
branch refs/heads/feature-x
detached
```

**Parsing**:
```typescript
async listWorktrees(repoPath: string): Promise<Worktree[]> {
  const output = await execAsync('git worktree list --porcelain', { cwd: repoPath })

  const worktrees: Worktree[] = []
  let current: Partial<Worktree> = {}

  for (const line of output.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push(current as Worktree)
      current = { path: line.substring(9) }
    } else if (line.startsWith('HEAD ')) {
      current.head = line.substring(5)
    } else if (line.startsWith('branch ')) {
      current.branch = line.substring(7).replace('refs/heads/', '')
    } else if (line === 'detached') {
      current.detached = true
    }
  }

  if (current.path) worktrees.push(current as Worktree)

  return worktrees
}
```

---

## Syncing Main Worktree

**Purpose**: Update `__main__` worktree to match upstream.

**Flow**:
```bash
cd {repo}/__main__

# 1. Fetch latest from upstream
git fetch {upstream}

# 2. Hard reset to upstream/main
git reset --hard {upstream}/main

# 3. Install dependencies
pnpm install
```

**Implementation**:
```typescript
async syncMain(
  repoPath: string,
  upstream: string,
  onProgress: ProgressCallback
): Promise<void> {
  const mainPath = path.join(repoPath, '__main__')

  onProgress('Fetching from upstream...')
  await execAsync(`git fetch ${upstream}`, { cwd: mainPath })

  onProgress('Resetting to upstream/main...')
  await execAsync(`git reset --hard ${upstream}/main`, { cwd: mainPath })

  onProgress('Installing dependencies...')
  await this.installDependencies(mainPath)
}
```

---

## Remote Management

### Listing Remotes

```bash
git remote -v
# Output:
# origin  git@github.com:user/repo.git (fetch)
# origin  git@github.com:user/repo.git (push)
# upstream  git@github.com:original/repo.git (fetch)
# upstream  git@github.com:original/repo.git (push)
```

**Implementation**:
```typescript
async listRemotes(repoPath: string): Promise<Remote[]> {
  const output = await execAsync('git remote -v', { cwd: repoPath })

  const remotes = new Map<string, string>()

  for (const line of output.stdout.split('\n')) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/)
    if (match) {
      remotes.set(match[1], match[2])
    }
  }

  return Array.from(remotes.entries()).map(([name, url]) => ({ name, url }))
}
```

### Adding Remotes

```bash
git remote add upstream git@github.com:original/repo.git
```

### Removing Remotes

```bash
git remote remove upstream
```

---

## Best Practices

1. **Always use bare repositories** - Efficient multi-worktree setup
2. **Create worktrees from upstream** - Avoid local branch divergence
3. **Use `-B` flag** - Force-reset local branches to upstream
4. **Symlink shared files** - `.env`, `.claude/` consistent across worktrees
5. **Copy template files** - `.env.example` independent per worktree
6. **Install deps in __main__ first** - Warm cache speeds up worktree installs
7. **Hard reset __main__** - Sync operations should be destructive (no local changes)
8. **Check for upstream** - Handle detached HEAD and no-upstream cases gracefully
