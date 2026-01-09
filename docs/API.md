# API Reference

Grove exposes a REST API with SSE streaming at `http://localhost:3000` (default).

## SSE State Stream

### GET /api/state

Server-Sent Events stream of full application state. Clients receive immediate state on connect and updates on every change.

**Response**: `text/event-stream`

**Event Format**:
```
data: {"repositories":[...],"progress":{"repo-id":"Cloning..."}}
```

**FullState Schema**:
```typescript
interface FullState {
  repositories: RepoWithWorktrees[]
  progress: Record<string, string>  // id/path -> message
}

interface RepoWithWorktrees {
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
  deleted_at: number | null
  worktrees: Worktree[]
}

interface Worktree {
  path: string
  repo_id: string
  branch: string
  head: string | null
  status: "creating" | "ready" | "error" | "deleting"
  commit_message: string | null
  dirty: boolean
  ahead: number
  behind: number
  last_status_check: number | null
  created_at: number
  deleted_at: number | null
}
```

**Client Example**:
```typescript
const es = new EventSource('/api/state')

es.onmessage = (event) => {
  const state = JSON.parse(event.data) as FullState
  console.log(`${state.repositories.length} repos`)
}
```

### GET /api/state/snapshot

Get current state as JSON (non-streaming).

**Response**: `application/json`

```json
{
  "repositories": [...],
  "progress": {}
}
```

## Repositories

### GET /api/repositories

List all tracked repositories.

**Response**:
```json
[
  {
    "id": "uuid",
    "provider": "github.com",
    "username": "user",
    "name": "repo",
    "clone_url": "git@github.com:user/repo.git",
    "local_path": "/Users/me/code/user/repo",
    "type": "bare",
    "default_branch": "main",
    "last_synced": 1704067200,
    "created_at": 1704067200,
    "deleted_at": null
  }
]
```

### POST /api/clone

Clone a git repository.

**Request**:
```json
{
  "url": "git@github.com:user/repo.git",
  "skip_install": false
}
```

**Response**:
```json
{
  "ok": true
}
```

**Error Response**:
```json
{
  "ok": false,
  "error": "Repository user/repo already exists at /path"
}
```

**Behavior**:
1. Validates git URL
2. Checks for existing repository
3. Inserts repository record (visible in UI immediately)
4. Spawns background task:
   - Clone as bare repository
   - Configure remotes
   - Create `.main` worktree
   - Install dependencies
   - Update status to ready

Progress updates pushed via SSE.

### DELETE /api/repositories/{id}

Delete a repository and all worktrees.

**Response**:
```json
{
  "success": true
}
```

**Behavior**:
1. Shows "Deleting..." progress
2. Removes directory from disk
3. Deletes from database (cascades to worktrees)

## Worktrees

### POST /api/worktree

Create a new worktree for a repository.

**Request**:
```json
{
  "repo_id": "uuid",
  "branch": "feature/new-feature",
  "skip_install": false
}
```

**Response**:
```json
{
  "ok": true,
  "message": "Creating worktree feature/new-feature"
}
```

**Branch to Directory Mapping**:
- `main` → `.main` (default branch)
- `feature/foo` → `feature--foo`
- `v1.0.0` → `v1.0.0` (dots preserved)
- `..` → `__` (traversal prevention)

**Behavior**:
1. Validates branch name
2. Inserts worktree record (status: creating)
3. Spawns background task:
   - Sync main worktree (fetch, pull, install)
   - Create git worktree
   - Share files from `.main` (symlinks/copies)
   - Install dependencies
   - Update status to ready

### DELETE /api/worktree/{path}

Delete a worktree.

**Path Parameter**: URL-encoded worktree path

**Response**:
```json
{
  "ok": true
}
```

**Behavior**:
1. Sets status to "deleting"
2. Runs `git worktree remove`
3. Cleans up directory
4. Deletes from database

## Actions

### POST /api/open

Open a path in VS Code.

**Request**:
```json
{
  "path": "/Users/me/code/user/repo/.main"
}
```

**Response**:
```json
{
  "ok": true
}
```

### POST /api/refresh/{id}

Fetch from remote and update worktree statuses.

**Response**:
```json
{
  "ok": true,
  "repo_id": "uuid"
}
```

**Behavior**:
1. Shows "Fetching..." progress
2. Runs `git fetch origin`
3. Updates all worktree git statuses
4. Updates `last_synced` timestamp

## MCP Endpoint

### ANY /mcp

Model Context Protocol endpoint for AI tool integration.

Uses streamable HTTP transport (stateless mode).

**Available Tools**:

| Tool | Input | Description |
|------|-------|-------------|
| `list_repositories` | none | List all tracked repositories |
| `clone_repository` | `{ url: string }` | Clone a git repository |
| `delete_repository` | `{ id: string }` | Delete a repository |
| `create_worktree` | `{ repo_id: string, branch: string }` | Create worktree |
| `delete_worktree` | `{ path: string }` | Delete worktree |
| `refresh_repository` | `{ id: string }` | Fetch and update |
| `get_state` | none | Get current full state |

## Error Handling

All endpoints return JSON errors:

```json
{
  "error": "Error message"
}
```

**Status Codes**:
- `200` - Success
- `400` - Bad request (invalid input)
- `404` - Not found
- `500` - Internal server error

## Progress Messages

During long operations, progress is tracked in `FullState.progress`:

| Key | When |
|-----|------|
| `{repo_id}` | Repository-level operations |
| `{worktree_path}` | Worktree-level operations |

**Example Progress Sequence** (clone):
```
"Cloning repository..."
"Configuring repository..."
"Fetching branches..."
"Detecting default branch..."
"Creating main worktree..."
"Installing (npm)..."
"Getting status..."
(cleared)
```
