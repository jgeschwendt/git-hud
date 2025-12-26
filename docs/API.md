# API Reference

git-hud uses Next.js Server Actions for mutations and SSE endpoints for streaming progress.

---

## Server Actions

Located in `src/app/actions.ts`. Server Actions are async functions marked with `'use server'`.

### cloneRepository

Clone a git repository and register it in the database.

```typescript
'use server'
export async function cloneRepository(url: string): Promise<{
  success: boolean
  id?: string
  error?: string
}>
```

**Parameters**:
- `url`: Git clone URL (SSH or HTTPS)

**Returns**:
- `success`: Whether operation completed
- `id`: Repository UUID if successful
- `error`: Error message if failed

**Behavior**:
1. Parse URL to extract provider/username/repo
2. Clone as bare repository to `~/.git-hud/clones/{provider}/{user}/{repo}`
3. Create `.git` file pointing to `.bare`
4. Configure remote fetch
5. Create `__main__` worktree
6. Insert into `repositories` table
7. Revalidate path

**Example**:
```typescript
const result = await cloneRepository('git@github.com:user/repo.git')
if (result.success) {
  console.log('Repository ID:', result.id)
}
```

---

### createWorktree

Create a new worktree for a repository.

```typescript
'use server'
export async function createWorktree(
  repoId: string,
  branch: string
): Promise<{
  success: boolean
  path?: string
  error?: string
}>
```

**Parameters**:
- `repoId`: Repository UUID
- `branch`: Branch name (creates if doesn't exist)

**Returns**:
- `success`: Whether operation started
- `path`: Worktree path (for SSE subscription)
- `error`: Error message if failed

**Behavior**:
1. Look up repository in database
2. Get worktree config (for upstream remote)
3. Create optimistic record in `worktrees` table (status: 'creating')
4. Revalidate path
5. Start async git operation:
   - Create worktree from upstream/main
   - Setup symlinks/copies
   - Install dependencies
   - Emit events to event bus
6. Return immediately with path

**Example**:
```typescript
const result = await createWorktree(repoId, 'feature/new-feature')
if (result.success) {
  // Subscribe to SSE for progress
  const es = new EventSource(`/api/worktree/${encodeURIComponent(result.path)}/stream`)
}
```

---

### deleteWorktree

Delete a worktree and its branch.

```typescript
'use server'
export async function deleteWorktree(
  worktreePath: string
): Promise<{
  success: boolean
  error?: string
}>
```

**Parameters**:
- `worktreePath`: Absolute path to worktree

**Returns**:
- `success`: Whether operation completed
- `error`: Error message if failed

**Behavior**:
1. Run `git worktree remove --force {path}`
2. Delete branch: `git branch -D {branch}`
3. Remove from `worktrees` table
4. Revalidate path

---

### syncMainWorktree

Sync `__main__` worktree with upstream.

```typescript
'use server'
export async function syncMainWorktree(
  repoId: string
): Promise<{
  success: boolean
  error?: string
}>
```

**Parameters**:
- `repoId`: Repository UUID

**Returns**:
- `success`: Whether operation completed
- `error`: Error message if failed

**Behavior**:
1. Get upstream remote from config (default: 'origin')
2. `git fetch {upstream}`
3. `git reset --hard {upstream}/main`
4. Install dependencies in `__main__`
5. Update `last_synced` in `repositories` table
6. Revalidate path

---

### updateWorktreeConfig

Update file sharing configuration for repository.

```typescript
'use server'
export async function updateWorktreeConfig(
  repoId: string,
  config: {
    symlink_patterns?: string[]
    copy_patterns?: string[]
    upstream_remote?: string
  }
): Promise<{
  success: boolean
  error?: string
}>
```

**Parameters**:
- `repoId`: Repository UUID
- `config`: Configuration object

**Returns**:
- `success`: Whether operation completed
- `error`: Error message if failed

**Behavior**:
1. Serialize arrays to JSON
2. Upsert into `worktree_config` table
3. Revalidate path

**Example**:
```typescript
await updateWorktreeConfig(repoId, {
  symlink_patterns: ['.env', '.claude'],
  copy_patterns: ['.env.example'],
  upstream_remote: 'upstream'
})
```

---

## SSE Endpoints

### GET /api/worktree/[path]/stream

Stream real-time progress for worktree creation.

**Parameters**:
- `path`: URL-encoded worktree path

**Response**: Server-Sent Events stream

**Event Format**:
```typescript
{
  type: 'progress' | 'complete' | 'error'
  message: string
  data?: any
}
```

**Example Events**:
```
data: {"type":"progress","message":"Creating worktree..."}

data: {"type":"progress","message":"Installing dependencies..."}

data: {"type":"complete","message":"Worktree ready"}
```

**Client Usage**:
```typescript
const es = new EventSource(`/api/worktree/${encodeURIComponent(path)}/stream`)

es.onmessage = (event) => {
  const data = JSON.parse(event.data)

  switch (data.type) {
    case 'progress':
      console.log(data.message)
      break
    case 'complete':
      console.log('Done!')
      es.close()
      break
    case 'error':
      console.error(data.message)
      es.close()
      break
  }
}

es.onerror = () => {
  console.error('Connection lost')
  es.close()
}
```

**Cleanup**: Stream automatically closes on `complete` or `error` events.

---

### GET /api/worktrees

List all worktrees for a repository.

**Query Parameters**:
- `repo`: Repository UUID

**Response**: JSON array of worktrees

**Example**:
```bash
GET /api/worktrees?repo=550e8400-e29b-41d4-a716-446655440000

[
  {
    "path": "/Users/jlg/.git-hud/clones/github/user/repo/__main__",
    "repo_id": "550e8400-e29b-41d4-a716-446655440000",
    "branch": "main",
    "head": "abc123...",
    "status": "ready",
    "commit_message": "Initial commit",
    "dirty": false,
    "ahead": 0,
    "behind": 0
  },
  {
    "path": "/Users/jlg/.git-hud/clones/github/user/feature-x",
    "repo_id": "550e8400-e29b-41d4-a716-446655440000",
    "branch": "feature/new-feature",
    "status": "creating"
  }
]
```

---

## Event Bus API

For internal use by server components.

### eventBus.emitWorktreeEvent

Emit a worktree event.

```typescript
import { eventBus } from '@/cli/event-bus'

eventBus.emitWorktreeEvent({
  worktreePath: '/path/to/worktree',
  type: 'progress',
  message: 'Installing dependencies...'
})
```

### eventBus.onWorktreeEvents

Subscribe to worktree events.

```typescript
const unsubscribe = eventBus.onWorktreeEvents(
  worktreePath,
  (event) => {
    console.log(event.message)
  }
)

// Cleanup
unsubscribe()
```

---

## Error Handling

All Server Actions follow this pattern:

```typescript
export async function serverAction(...args) {
  const db = getDb()

  try {
    // Operation
    const result = await doWork()

    db.close()
    revalidatePath('/')

    return { success: true, ...result }
  } catch (error) {
    db.close()
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
```

**Client handling**:
```typescript
const result = await serverAction()

if (!result.success) {
  console.error(result.error)
  // Show error to user
}
```

---

## Type Safety

All actions and endpoints share types from `src/lib/types.ts`:

```typescript
import type { Repository, Worktree, WorktreeConfig } from '@/lib/types'

export async function createWorktree(
  repoId: string,
  branch: string
): Promise<{ success: boolean; path?: string; error?: string }>
```

This ensures type safety between client and server without additional codegen.
