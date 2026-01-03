import { NextRequest } from "next/server";
import { listRepositories, deleteRepository } from "@/lib/repository";
import { listWorktrees } from "@/lib/worktree";

export async function GET() {
  const repositories = listRepositories();
  const reposWithWorktrees = repositories.map((repo) => ({
    ...repo,
    worktrees: listWorktrees(repo.id),
  }));
  return Response.json(reposWithWorktrees);
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return Response.json({ error: "Missing id parameter" }, { status: 400 });
  }

  // Fire and forget - state updates pushed via SSE
  deleteRepository(id).catch(console.error);

  return Response.json({ ok: true });
}
