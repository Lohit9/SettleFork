/**
 * Path D SSE stream handler — thin layer that produces a
 * `ReadableStream<Uint8Array>` ready to wrap in a Next.js Route Handler
 * `Response`.
 *
 * Lives outside `app/api/.../route.ts` so the streaming logic is
 * unit-testable without Next.js Route Handler context. The Route
 * Handler at `app/api/projects/[projectId]/mapping/path-d/stream/
 * route.ts` is a thin glue layer (~30 LOC) that:
 *   1. Authenticates the request (cookies + supabase getUser)
 *   2. Authorises (`requireProjectPermission(projectId, 'editor')`)
 *   3. Parses + validates the request body (sourceTableIds, targetTableIds)
 *   4. Delegates here: `pathDSseStreamHandler({...args, abortSignal: request.signal})`
 *   5. Returns `new Response(stream, {headers: SSE_HEADERS})`
 *
 * This handler:
 *   - Runs `checkPathDPreconditions` (flag + threshold)
 *   - On precondition failure, emits a single `error` event in-stream
 *     and closes (no HTTP 4xx — clients always see an SSE stream)
 *   - On precondition success, invokes `runPathDMapping` with an
 *     `onEvent` callback that SSE-encodes each event and enqueues it
 *     onto the controller
 *   - Always closes the stream after the orchestrator returns
 *     (regardless of success/failure — the orchestrator emits the
 *     terminal `done` or `error` event itself)
 *   - Bridges the external abort signal end-to-end (Next.js
 *     Request.signal → pathDSseStreamHandler abortSignal arg →
 *     orchestrator abortSignal arg → Anthropic stream.controller.abort)
 *
 * ── HTTP status convention ──────────────────────────────────────────────────
 * This handler always emits a 200 response (the Route Handler sets the
 * status). Errors are surfaced as in-stream `error` events, not via
 * HTTP status codes. This convention:
 *   - Keeps the client's EventSource consumer simple (always parse SSE)
 *   - Avoids the brief connection-open-then-fail flicker that 4xx
 *     responses produce on EventSource
 *   - Mirrors how the OpenAI / Anthropic streaming APIs themselves
 *     surface in-stream errors (200 + chunked error frame)
 *
 * Auth / permission errors are the ONE exception — those are surfaced
 * as 401/403 HTTP status codes from the Route Handler before this
 * handler is even called. By the time `pathDSseStreamHandler` runs,
 * the caller has been authenticated and authorised.
 */

import {
  runPathDMapping,
  type RunPathDMappingArgs,
} from '@/lib/ai/path-d-mapping'
import { checkPathDPreconditions } from '@/lib/ai/path-d-preconditions'
import { supabaseAdmin } from '@/lib/supabase/admin'
import {
  encodePathDEvent,
  type PathDEvent,
} from '@/lib/types/path-d-events'

export interface PathDSseStreamHandlerArgs {
  projectId: string
  userId: string
  sourceTableIds: string[]
  targetTableIds: string[]
  /**
   * Abort signal from the request. Wired through to the orchestrator's
   * `abortSignal` arg. Fires when the client closes the connection;
   * the orchestrator aborts the Anthropic stream and persistence runs
   * on whatever was parsed.
   */
  abortSignal?: AbortSignal
  /**
   * Test-only injection. Production callsites pass nothing; this lets
   * unit tests substitute a mock orchestrator + mock admin without
   * mocking the underlying modules globally via `vi.mock`.
   */
  injection?: {
    runOrchestrator?: (args: RunPathDMappingArgs) => Promise<unknown>
    admin?: typeof supabaseAdmin
  }
}

/**
 * Build the SSE response stream for a Path D run.
 *
 * Returns a `ReadableStream<Uint8Array>` whose chunks are
 * SSE-encoded `PathDEvent` frames. The caller wraps this in a
 * `Response` with `Content-Type: text/event-stream` headers.
 *
 * The stream:
 *   - Emits one `error` event + closes if preconditions fail.
 *   - Otherwise, runs the orchestrator with an `onEvent` callback that
 *     enqueues each event. The orchestrator emits the terminal
 *     `done` or `error` event itself.
 *   - Closes after the orchestrator returns (success or failure paths
 *     both end with a terminal event already emitted).
 */
export function pathDSseStreamHandler(
  args: PathDSseStreamHandlerArgs,
): ReadableStream<Uint8Array> {
  const admin = args.injection?.admin ?? supabaseAdmin
  const runOrchestrator =
    args.injection?.runOrchestrator ??
    (runPathDMapping as (args: RunPathDMappingArgs) => Promise<unknown>)

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // Helper: enqueue one event onto the stream. Wraps controller
      // calls in a try/catch so a closed controller (e.g., client
      // already disconnected) doesn't crash the orchestrator.
      const enqueue = (event: PathDEvent): void => {
        try {
          controller.enqueue(encodePathDEvent(event))
        } catch {
          // Stream already closed by the client. Subsequent enqueue
          // attempts no-op; the orchestrator will exit shortly via
          // the abort signal that triggered the close.
        }
      }

      try {
        // 1. Precondition gate (flag + threshold). Failures land as a
        //    single in-stream `error` event with phase='precondition'.
        const pre = await checkPathDPreconditions({
          targetTableIds: args.targetTableIds,
          admin,
        })
        if (pre.ok === false) {
          enqueue({
            kind: 'error',
            phase: 'precondition',
            message: pre.error,
          })
          controller.close()
          return
        }

        // 2. Run the orchestrator. The `onEvent` callback enqueues each
        //    event onto the SSE stream. The orchestrator emits the
        //    terminal `done` (success) or `error` (cost ceiling /
        //    internal) event itself, so we don't need to emit one here.
        await runOrchestrator({
          projectId: args.projectId,
          userId: args.userId,
          sourceTableIds: args.sourceTableIds,
          targetTableIds: args.targetTableIds,
          abortSignal: args.abortSignal,
          onEvent: enqueue,
        })
      } catch (err) {
        // Defence in depth — the orchestrator's outer try/catch
        // normally catches everything and emits an `error` event itself,
        // so this path only fires if `runOrchestrator` synchronously
        // throws BEFORE setting up its own emit machinery (e.g., a
        // mock injection that throws on call). Emit a generic internal
        // error so the SSE consumer always sees a terminal event.
        enqueue({
          kind: 'error',
          phase: 'internal',
          message: (err as Error).message,
        })
      } finally {
        try {
          controller.close()
        } catch {
          // Already closed (client disconnected, or we hit the catch
          // path twice). Safe to swallow.
        }
      }
    },
    cancel() {
      // Client disconnected. The orchestrator's abort signal (passed
      // through `args.abortSignal` from the Route Handler's
      // `request.signal`) is what actually cascades into the Anthropic
      // stream's controller.abort(). This `cancel` callback runs
      // alongside that signal firing — nothing extra to do here.
    },
  })
}

/**
 * Headers for an SSE response. Exported so the Route Handler can spread
 * them onto the `Response` constructor without re-defining the standard
 * SSE header set.
 *
 * `X-Accel-Buffering: no` is essential when running behind Vercel /
 * nginx — without it the platform may buffer SSE chunks until a
 * boundary, defeating the streaming UX entirely.
 */
export const PATH_D_SSE_HEADERS: HeadersInit = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
}
