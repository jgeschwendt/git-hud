import { cloneRepository } from "@/lib/clone";

export async function POST(request: Request) {
	const { url } = await request.json();

	if (!url) {
		return Response.json({ error: "url is required" }, { status: 400 });
	}

	// Fire and forget - state updates pushed via SSE
	cloneRepository(url).catch(console.error);

	return Response.json({ ok: true });
}
