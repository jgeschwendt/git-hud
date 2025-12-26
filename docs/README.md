# git-hud Documentation

Technical documentation for git-hud v2 implementation.

---

## Documents

### [ARCHITECTURE.md](./ARCHITECTURE.md)
System design and architectural decisions.

**Contents**:
- Directory structure (`~/.git-hud/`)
- Process architecture (HTTP server, event bus, database)
- State management patterns
- Installation architecture (single binary approach)
- Technology stack decisions
- Event system design
- File system organization

**Read this first** to understand the foundational patterns.

---

### [DATABASE.md](./DATABASE.md)
SQLite schema and query patterns.

**Contents**:
- Complete database schema (repositories, worktrees, config, remotes)
- Prepared statement patterns
- Type definitions
- Transaction patterns
- Migration strategy
- Best practices

**Reference** when implementing data layer.

---

### [STATE_MANAGEMENT.md](./STATE_MANAGEMENT.md)
Client-side state reconciliation for concurrent operations.

**Contents**:
- The race condition problem (v1 issue)
- Three-tier state solution
- Reconciliation algorithm
- State transitions (create, delete)
- Component usage examples
- Comparison with other patterns

**Critical** for understanding how concurrent worktree creation works without bugs.

---

### [API.md](./API.md)
Server Actions and SSE endpoint reference.

**Contents**:
- Server Actions (cloneRepository, createWorktree, etc.)
- SSE streaming endpoints
- Event bus API
- Error handling patterns
- Type safety

**Reference** when implementing features.

---

### [GIT_OPERATIONS.md](./GIT_OPERATIONS.md)
Git workflows and command patterns.

**Contents**:
- Repository cloning (bare + `__main__`)
- Worktree creation and file sharing
- Status tracking
- Syncing main worktree
- Remote management
- Best practices

**Reference** when implementing git integrations.

---

### [DEPLOYMENT.md](./DEPLOYMENT.md)
Build, release, and installation processes.

**Contents**:
- Build system (Bun compile)
- Multi-platform builds
- GitHub Actions release workflow
- Installation script
- Auto-update mechanism
- Troubleshooting

**Reference** for release engineering.

---

## Quick Start

1. **Architecture First**: Read [ARCHITECTURE.md](./ARCHITECTURE.md) to understand the system
2. **State Management**: Read [STATE_MANAGEMENT.md](./STATE_MANAGEMENT.md) to understand the reconciliation pattern
3. **Implementation**: Refer to other docs as needed during development

---

## Implementation Plan

See [v2-plan.md](../v2-plan.md) for the complete phase-by-phase implementation plan.

**Phases**:
- **Phase 0**: Architecture & Documentation (this folder)
- **Phase 1**: Hello World Installation (curl-installable binary)
- **Phase 2**: Core Data Models
- **Phase 3**: Git Operations Engine
- **Phase 4**: Event System & SSE
- **Phase 5**: UI Components

---

## Design Philosophy

**Architecture → Documentation → Implementation**

All architectural decisions are documented before writing code. This prevents:
- Technical debt from undocumented patterns
- Inconsistent implementations across features
- Knowledge loss during refactors
- Onboarding friction for new contributors

**Key Principles**:
1. Single source of truth (database, not files)
2. Optimistic UI with server reconciliation
3. Real-time progress via SSE
4. Type safety across client/server
5. Zero dependencies on target machine

---

## Contributing

When adding features:

1. Update relevant docs **before** implementing
2. Ensure consistency with existing patterns
3. Add examples to appropriate doc
4. Update this README if adding new docs

---

## Questions?

- Architecture decisions: See [ARCHITECTURE.md](./ARCHITECTURE.md)
- State bugs: See [STATE_MANAGEMENT.md](./STATE_MANAGEMENT.md)
- Database schema: See [DATABASE.md](./DATABASE.md)
- API contracts: See [API.md](./API.md)
- Git workflows: See [GIT_OPERATIONS.md](./GIT_OPERATIONS.md)
- Build issues: See [DEPLOYMENT.md](./DEPLOYMENT.md)
