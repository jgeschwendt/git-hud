---
title: git-hud Project Overview
type: note
permalink: projects/git-hud-project-overview
---

# git-hud

Git worktree management tool for working with multiple feature branches simultaneously.

## Current State

**v1 (implemented)**: Called "Bare" - Next.js web application
- Stack: Next.js 16, React 19, TypeScript, Tailwind CSS v4
- Location: `/Users/jlg/GitHub/jgeschwendt/git-hud`
- Branch: `dev`

**v2 (planned)**: Single binary rewrite
- Goal: Installable via `curl | bash` with no dependencies
- Tech: Bun runtime + Next.js standalone + SQLite
- Target: 50-80MB single binary

## Core Concept

Uses bare repository pattern with worktrees:
1. Clone repo as bare (`.bare/` directory)
2. Create `__main__` worktree (source of truth)
3. Create feature worktrees as siblings for each branch
4. Share files via symlinks (`.env`, `.claude/`) and copies
5. Warm dependency caching (install once, share across worktrees)

## Key Features

- Web UI for repository/worktree management
- SSE progress streaming for long operations
- External tool integration (VS Code, Terminal, Claude CLI)
- Configurable file sharing patterns per repository
- Multi-repository support grouped by GitHub username

## Directory Structure

```
~/.git-hud/clones/
  github/
    {username}/
      {repo}/
        .bare/          # Bare git repository
        .git            # Points to .bare
        __main__/       # Primary worktree
      {feature-x}/      # Feature worktree (sibling)
```

## Current Status

- v1 is functional with complete spec in `v1-spec.md`
- v2 implementation plan in `v2-plan.md`
- Working directory: `/Users/jlg/GitHub/jgeschwendt/git-hud`
- Memory location: `.memory/basic/` (within repo)
