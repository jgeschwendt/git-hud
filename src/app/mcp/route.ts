import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { listRepositories, deleteRepository } from "@/lib/repository";
import { cloneRepository } from "@/lib/clone";
import { createWorktree, deleteWorktree, listWorktrees, refreshWorktrees } from "@/lib/worktree";

const server = new McpServer({
  name: "grove",
  version: "0.1.1",
});

server.registerTool(
  "list_repositories",
  {
    description: "List all tracked git repositories in grove",
  },
  async () => {
    const repositories = listRepositories();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(repositories, undefined, 2),
        },
      ],
    };
  },
);

server.registerTool(
  "delete_repository",
  {
    description: "Delete a repository and all its worktrees from grove",
    inputSchema: z.object({
      id: z.string().describe("The repository ID to delete"),
    }),
  },
  async ({ id }) => {
    const result = await deleteRepository(id);
    return {
      content: [
        {
          type: "text",
          text: result.success
            ? `Repository ${id} deleted successfully`
            : `Failed to delete repository: ${result.error}`,
        },
      ],
    };
  },
);

server.registerTool(
  "clone_repository",
  {
    description: "Clone a git repository into grove",
    inputSchema: z.object({
      url: z.string().describe("Git clone URL (SSH or HTTPS)"),
    }),
  },
  async ({ url }) => {
    const result = await cloneRepository(url);

    return {
      content: [
        {
          type: "text",
          text: result.success
            ? `Repository cloned successfully!\nID: ${result.repoId}`
            : `Failed to clone repository: ${result.error}`,
        },
      ],
    };
  },
);

server.registerTool(
  "list_worktrees",
  {
    description: "List all worktrees for a repository",
    inputSchema: z.object({
      repo_id: z.string().describe("The repository ID"),
    }),
  },
  async ({ repo_id }) => {
    const worktrees = listWorktrees(repo_id);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(worktrees, undefined, 2),
        },
      ],
    };
  },
);

server.registerTool(
  "create_worktree",
  {
    description: "Create a new worktree for a repository",
    inputSchema: z.object({
      repo_id: z.string().describe("The repository ID"),
      branch: z.string().describe("Branch name to checkout or create"),
    }),
  },
  async ({ repo_id, branch }) => {
    const result = await createWorktree(repo_id, branch);

    return {
      content: [
        {
          type: "text",
          text: result.success
            ? `Worktree created at: ${result.path}`
            : `Failed to create worktree: ${result.error}`,
        },
      ],
    };
  },
);

server.registerTool(
  "delete_worktree",
  {
    description: "Delete a worktree from a repository",
    inputSchema: z.object({
      repo_id: z.string().describe("The repository ID"),
      path: z.string().describe("The worktree path to delete"),
    }),
  },
  async ({ repo_id, path }) => {
    const result = await deleteWorktree(repo_id, path);
    return {
      content: [
        {
          type: "text",
          text: result.success
            ? `Worktree deleted: ${path}`
            : `Failed to delete worktree: ${result.error}`,
        },
      ],
    };
  },
);

server.registerTool(
  "refresh_worktrees",
  {
    description: "Refresh git status for all worktrees in a repository",
    inputSchema: z.object({
      repo_id: z.string().describe("The repository ID"),
    }),
  },
  async ({ repo_id }) => {
    const result = await refreshWorktrees(repo_id);
    return {
      content: [
        {
          type: "text",
          text: result.success
            ? `Refreshed ${result.updated} worktrees`
            : "Failed to refresh worktrees",
        },
      ],
    };
  },
);

const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // stateless mode
  enableJsonResponse: true,
});

server.connect(transport);

export async function POST(request: Request) {
  return transport.handleRequest(request);
}

export async function GET(request: Request) {
  return transport.handleRequest(request);
}

export async function DELETE(request: Request) {
  return transport.handleRequest(request);
}
