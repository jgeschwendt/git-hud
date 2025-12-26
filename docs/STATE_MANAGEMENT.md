# Client State Management

This document explains how git-hud handles concurrent operations without UI race conditions.

---

## The Problem

**v1 Issue**: Creating multiple worktrees concurrently causes optimistic placeholders to disappear when server revalidates.

**Example Race Condition**:
```
1. User creates worktree A
   → UI adds placeholder A
2. User creates worktree B
   → UI adds placeholder B
3. Server finishes creating A
   → Revalidation fetches server data [A]
   → UI state replaced with [A]
   → Placeholder B disappears!
```

---

## The Solution: Three-Tier State

Instead of a single state source, maintain three independent state layers and reconcile them.

### State Structure

```typescript
type ClientState = {
  // Source of truth from server
  server: Worktree[]

  // Optimistic creates (not yet confirmed by server)
  creating: Map<UUID, {
    worktree: Worktree     // Placeholder with temporary path
    realPath?: string      // Actual path after server action starts
  }>

  // Pending deletes (still in server but marked for removal)
  deleting: Set<string>    // Worktree paths being deleted

  // Live progress messages
  progress: Map<string, string>  // path → message
}
```

### Reconciliation Function

```typescript
function reconcile(state: ClientState): Worktree[] {
  const serverPaths = new Set(state.server.map(w => w.path))

  // 1. Start with server data, filter out items being deleted
  let result = state.server.filter(w => !state.deleting.has(w.path))

  // 2. Add creating items that aren't in server yet
  const pending = Array.from(state.creating.values())
    .filter(({ realPath }) => {
      // Keep placeholder if:
      // - No real path yet (server action hasn't started)
      // - Or real path not in server (server hasn't confirmed)
      return !realPath || !serverPaths.has(realPath)
    })
    .map(({ worktree }) => worktree)

  // 3. Merge and sort
  return [...result, ...pending].sort((a, b) => a.path.localeCompare(b.path))
}
```

**Key Insight**: The reconcile function MERGES states instead of replacing. Optimistic items remain visible until confirmed by server.

---

## State Transitions

### Creating a Worktree

```typescript
async function handleCreate(branch: string) {
  const tempId = crypto.randomUUID()
  const tempPath = `pending-${tempId}`

  // 1. Add optimistic placeholder
  setState(prev => ({
    ...prev,
    creating: new Map(prev.creating).set(tempId, {
      worktree: {
        path: tempPath,
        repo_id: repoId,
        branch,
        status: 'creating',
        created_at: Date.now(),
        dirty: false,
        ahead: 0,
        behind: 0
      }
    })
  }))

  // 2. Call server action (async)
  const result = await createWorktree(repoId, branch)

  if (!result.success) {
    // Remove placeholder on error
    setState(prev => {
      const creating = new Map(prev.creating)
      creating.delete(tempId)
      return { ...prev, creating }
    })
    return
  }

  // 3. Update with real path
  setState(prev => {
    const creating = new Map(prev.creating)
    const item = creating.get(tempId)
    if (item) {
      item.realPath = result.path
      item.worktree.path = result.path
    }
    return { ...prev, creating }
  })

  // 4. Subscribe to SSE progress
  const es = new EventSource(
    `/api/worktree/${encodeURIComponent(result.path)}/stream`
  )

  es.onmessage = (event) => {
    const data = JSON.parse(event.data)

    if (data.type === 'progress') {
      // Update progress message
      setState(prev => ({
        ...prev,
        progress: new Map(prev.progress).set(result.path, data.message)
      }))
    }

    if (data.type === 'complete') {
      // 5. Fetch fresh server data (MERGE, don't replace)
      startTransition(async () => {
        const fresh = await fetch(`/api/worktrees?repo=${repoId}`)
          .then(r => r.json())

        setState(prev => {
          const creating = new Map(prev.creating)
          creating.delete(tempId)  // Remove placeholder

          return {
            ...prev,
            server: fresh,  // Update server state
            creating        // Keep other creating items
          }
        })
      })

      es.close()
    }
  }
}
```

### Deleting a Worktree

```typescript
async function handleDelete(worktreePath: string) {
  // 1. Mark as deleting (optimistically hide)
  setState(prev => ({
    ...prev,
    deleting: new Set(prev.deleting).add(worktreePath)
  }))

  // 2. Call server action
  await deleteWorktree(worktreePath)

  // 3. Refetch server data
  const fresh = await fetch(`/api/worktrees?repo=${repoId}`)
    .then(r => r.json())

  setState(prev => {
    const deleting = new Set(prev.deleting)
    deleting.delete(worktreePath)

    return {
      ...prev,
      server: fresh,
      deleting
    }
  })
}
```

---

## Component Usage

```typescript
'use client'

import { useState, useMemo, useTransition } from 'react'

export function WorktreeManager({ repoId, initial }: {
  repoId: string
  initial: Worktree[]
}) {
  const [isPending, startTransition] = useTransition()
  const [state, setState] = useState<ClientState>({
    server: initial,
    creating: new Map(),
    deleting: new Set(),
    progress: new Map()
  })

  // Reconcile state every render
  const worktrees = useMemo(() => reconcile(state), [state])

  return (
    <div>
      {worktrees.map(wt => {
        const progressMsg = state.progress.get(wt.path)
        const isCreating = wt.status === 'creating'
        const isDeleting = state.deleting.has(wt.path)

        return (
          <div key={wt.path} style={{ opacity: isDeleting ? 0.5 : 1 }}>
            <strong>{wt.branch}</strong>
            {isCreating && <span> (creating...)</span>}
            {progressMsg && <div>{progressMsg}</div>}
          </div>
        )
      })}
    </div>
  )
}
```

---

## Why This Works

**Problem with naive approach**:
```typescript
// ❌ BAD: Server revalidation overwrites everything
const [worktrees, setWorktrees] = useState(initial)

// User creates worktree A
setWorktrees([...worktrees, placeholderA])

// User creates worktree B
setWorktrees([...worktrees, placeholderB])

// Server finishes A, revalidates
setWorktrees(serverData)  // ← B disappears!
```

**Solution with reconciliation**:
```typescript
// ✅ GOOD: Server data merged with optimistic state
const [state, setState] = useState({
  server: initial,
  creating: new Map(),
  // ...
})

// User creates A
setState({ ...state, creating: new Map([['a', placeholderA]]) })

// User creates B
setState({ ...state, creating: new Map([['a', placeholderA], ['b', placeholderB]]) })

// Server finishes A
setState({
  server: [realA],           // A now in server
  creating: new Map([['b', placeholderB]])  // B still creating
})

// reconcile() returns: [realA, placeholderB]
```

---

## Best Practices

1. **Never directly replace server state** - Always update via setState to preserve other layers
2. **Use unique IDs for optimistic items** - UUID prevents path collisions
3. **Track both temp and real paths** - Enables smooth transition from optimistic to real
4. **Clean up on completion/error** - Remove from creating/deleting maps when done
5. **Use React.useTransition** - Mark server fetches as non-urgent updates
6. **Memoize reconciliation** - useMemo prevents unnecessary recalculations

---

## Comparison with Other Patterns

### vs. Optimistic UI (simple)
```typescript
// Simple optimistic: no concurrent support
setState([...items, newItem])
await serverAction()
revalidate()  // ← overwrites newItem if still pending
```

### vs. TanStack Query
```typescript
// TanStack: optimistic updates via setQueryData
queryClient.setQueryData(['items'], old => [...old, newItem])
// Still needs manual reconciliation for concurrent ops
```

### vs. Redux/Zustand
```typescript
// Redux: similar pattern, more boilerplate
dispatch({ type: 'ADD_OPTIMISTIC', payload: newItem })
dispatch({ type: 'SERVER_UPDATED', payload: serverData })
// Reducer must implement reconciliation logic
```

**git-hud approach**: Minimal dependencies, explicit reconciliation function, works with React Server Components and Server Actions.
