import { createWorktree, deleteWorktree } from "@/lib/worktree";

export async function POST(request: Request) {
	const { repo_id, branch } = await request.json();

	if (!repo_id || !branch) {
		return Response.json(
			{ error: "repo_id and branch are required" },
			{ status: 400 }
		);
	}

	// Fire and forget - state updates pushed via SSE
	createWorktree(repo_id, branch).catch(console.error);

	return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
	const { searchParams } = new URL(request.url);
	const repo_id = searchParams.get("repo_id");
	const path = searchParams.get("path");

	if (!repo_id || !path) {
		return Response.json(
			{ error: "repo_id and path are required" },
			{ status: 400 }
		);
	}

	// Fire and forget - state updates pushed via SSE
	deleteWorktree(repo_id, path).catch(console.error);

	return Response.json({ ok: true });
}
