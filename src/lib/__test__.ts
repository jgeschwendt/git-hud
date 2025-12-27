#!/usr/bin/env bun

import {
  getDb,
  insertRepository,
  getRepository,
  listRepositories,
  insertWorktree,
  listWorktrees,
  updateWorktreeStatus,
  deleteWorktree,
  deleteRepository
} from './db'

console.log('Testing database operations...\n')

// Test repository operations
console.log('1. Creating repository...')
const repoId = insertRepository({
  provider: 'github',
  username: 'jgeschwendt',
  name: 'git-hud',
  clone_url: 'https://github.com/jgeschwendt/git-hud.git',
  local_path: '/Users/test/.git-hud/clones/github/jgeschwendt/git-hud',
  type: 'bare',
  last_synced: Date.now()
})
console.log('✓ Created repository:', repoId)

console.log('\n2. Fetching repository...')
const repo = getRepository(repoId)
console.log('✓ Repository:', repo?.name, `(${repo?.provider}/${repo?.username})`)

console.log('\n3. Listing repositories...')
const repos = listRepositories()
console.log('✓ Found', repos.length, 'repositories')

// Test worktree operations
console.log('\n4. Creating worktree...')
insertWorktree({
  path: '/Users/test/.git-hud/clones/github/jgeschwendt/git-hud/__main__',
  repo_id: repoId,
  branch: 'main',
  head: 'abc123',
  status: 'creating',
  commit_message: null,
  dirty: false,
  ahead: 0,
  behind: 0,
  last_status_check: null,
  vscode_pid: null,
  vscode_opened_at: null
})
console.log('✓ Created worktree')

console.log('\n5. Listing worktrees...')
const worktrees = listWorktrees(repoId)
console.log('✓ Found', worktrees.length, 'worktrees')

console.log('\n6. Updating worktree status...')
updateWorktreeStatus(worktrees[0].path, 'ready', 'abc123', 'Initial commit')
console.log('✓ Updated worktree status to ready')

console.log('\n7. Creating feature worktree...')
insertWorktree({
  path: '/Users/test/.git-hud/clones/github/jgeschwendt/git-hud/__feature-test__',
  repo_id: repoId,
  branch: 'feature/test',
  head: 'def456',
  status: 'ready',
  commit_message: 'Add test feature',
  dirty: true,
  ahead: 2,
  behind: 0,
  last_status_check: Date.now(),
  vscode_pid: 12345,
  vscode_opened_at: Date.now()
})
console.log('✓ Created feature worktree')

const allWorktrees = listWorktrees(repoId)
console.log('✓ Total worktrees:', allWorktrees.length)

// Cleanup
console.log('\n8. Cleaning up...')
deleteWorktree(worktrees[0].path)
deleteRepository(repoId)
console.log('✓ Cleanup complete')

console.log('\n✅ All database operations successful!')

// Close database
const db = getDb()
db.close()
