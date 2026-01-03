import { NextRequest } from 'next/server'
import { getWorktree } from '@/lib/db'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string }> }
) {
  const { path } = await params
  const worktreePath = decodeURIComponent(path)

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      // Send initial status
      const worktree = getWorktree(worktreePath)
      if (!worktree) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'error', message: 'Worktree not found' })}\n\n`)
        )
        controller.close()
        return
      }

      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: 'status', status: worktree.status })}\n\n`)
      )

      // Poll for status updates
      const interval = setInterval(() => {
        const updated = getWorktree(worktreePath)
        if (!updated) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'error', message: 'Worktree removed' })}\n\n`)
          )
          clearInterval(interval)
          controller.close()
          return
        }

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'status', status: updated.status })}\n\n`)
        )

        // If ready or error, complete the stream
        if (updated.status === 'ready' || updated.status === 'error') {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'complete', worktree: updated })}\n\n`)
          )
          clearInterval(interval)
          controller.close()
        }
      }, 500)

      // Cleanup on client disconnect
      req.signal.addEventListener('abort', () => {
        clearInterval(interval)
        controller.close()
      })
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  })
}
