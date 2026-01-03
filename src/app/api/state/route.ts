/**
 * SSE endpoint for pushing full state to clients
 *
 * Clients connect once and receive state updates whenever anything changes.
 * No polling, no debounced fetches - server pushes when ready.
 */

import { getFullState, subscribeState, type FullState } from "@/lib/state";

export async function GET() {
	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | null = null;
	let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream({
		start(controller) {
			// Send initial state immediately on connect
			const initial = getFullState();
			controller.enqueue(encoder.encode(`data: ${JSON.stringify(initial)}\n\n`));

			// Subscribe to state changes
			unsubscribe = subscribeState((state: FullState) => {
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(state)}\n\n`));
				} catch {
					// Client disconnected - cleanup happens in cancel()
				}
			});

			// Heartbeat to keep connection alive through proxies
			heartbeatInterval = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(`:keepalive\n\n`));
				} catch {
					// Client disconnected
				}
			}, 30000);
		},
		cancel() {
			// Clean up when client disconnects
			if (unsubscribe) unsubscribe();
			if (heartbeatInterval) clearInterval(heartbeatInterval);
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}
