/**
 * Path D SSE streaming Route Handler.
 *
 * `POST /api/projects/[projectId]/mapping/path-d/stream`
 *
 * Body:
 *   { sourceTableIds: string[], targetTableIds: string[] }
 *
 * Response: `text/event-stream`. Frames are `PathDEvent` instances —
 * see `lib/types/path-d-events.ts` for the discriminated union and
 * the `section_completed` vs `section_persisted` timing contract.
 *
 * This file is thin glue. The streaming orchestration lives in
 * `lib/ai/path-d-stream-handler.ts:pathDSseStreamHandler` so that
 * unit tests can exercise the streaming logic without mocking the
 * Next.js Route Handler context.
 *
 * ── Pipeline ────────────────────────────────────────────────────────────────
 *   1. Auth — `await createClient()` + `supabase.auth.getUser()`. 401 on
 *      unauthenticated.
 *   2. Project access — `requireProjectPermission(projectId, 'editor')`.
 *      403 on insufficient role (viewer / non-member / wrong org).
 *   3. Body validation — non-empty `sourceTableIds` and `targetTableIds`
 *      arrays. 400 on malformed.
 *   4. Delegate — `pathDSseStreamHandler({...args, abortSignal: request.signal})`.
 *   5. Return — 200 with the SSE stream as body.
 *
 * Auth + permission errors land as HTTP 4xx (no SSE stream opens).
 * Precondition + runtime errors land as in-stream `error` events with
 * 200 status — see the stream-handler module's "HTTP status convention"
 * docblock for the rationale.
 *
 * ── maxDuration ─────────────────────────────────────────────────────────────
 * Vercel default is 10s for serverless. Path D streams can run 3-5
 * minutes. Pin `maxDuration = 600` (10 min) — the same envelope as the
 * happy-path integration test in Sub-PR 4b.
 */

import { createClient } from '@/lib/supabase/server'
import { requireProjectPermission } from '@/lib/actions/role-resolution'
import {
  pathDSseStreamHandler,
  PATH_D_SSE_HEADERS,
} from '@/lib/ai/path-d-stream-handler'

export const maxDuration = 600 // requires Vercel Pro; matches Path D envelope

interface RouteContext {
  params: Promise<{ projectId: string }>
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { projectId } = await context.params

  // 1. Auth.
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return Response.json(
      { success: false, error: 'Not authenticated' },
      { status: 401 },
    )
  }

  // 2. Project access.
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) {
    return Response.json(
      { success: false, error: perm.error ?? 'Insufficient permissions' },
      { status: 403 },
    )
  }

  // 3. Body validation.
  let body: { sourceTableIds?: unknown; targetTableIds?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return Response.json(
      { success: false, error: 'Body must be JSON' },
      { status: 400 },
    )
  }
  if (
    !Array.isArray(body.sourceTableIds) ||
    body.sourceTableIds.length === 0 ||
    !body.sourceTableIds.every((id) => typeof id === 'string')
  ) {
    return Response.json(
      {
        success: false,
        error: 'sourceTableIds must be a non-empty string array',
      },
      { status: 400 },
    )
  }
  if (
    !Array.isArray(body.targetTableIds) ||
    body.targetTableIds.length === 0 ||
    !body.targetTableIds.every((id) => typeof id === 'string')
  ) {
    return Response.json(
      {
        success: false,
        error: 'targetTableIds must be a non-empty string array',
      },
      { status: 400 },
    )
  }

  // 4. Delegate to the streaming handler.
  const stream = pathDSseStreamHandler({
    projectId,
    userId: user.id,
    sourceTableIds: body.sourceTableIds as string[],
    targetTableIds: body.targetTableIds as string[],
    abortSignal: request.signal,
  })

  // 5. Return the SSE stream.
  return new Response(stream, {
    status: 200,
    headers: PATH_D_SSE_HEADERS,
  })
}
