import { listRepositories } from "@/lib/repository";
import { refreshWorktrees } from "@/lib/worktree";

export async function POST(request: Request) {
	const { repo_id } = await request.json().catch(() => ({}));

	if (repo_id) {
		// Fire and forget - state updates pushed via SSE
		refreshWorktrees(repo_id).catch(console.error);
	} else {
		// Refresh all repositories
		const repos = listRepositories();
		for (const repo of repos) {
			refreshWorktrees(repo.id).catch(console.error);
		}
	}

	return Response.json({ ok: true });
}
