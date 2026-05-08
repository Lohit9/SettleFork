/**
 * Path D SSE event protocol — discriminated union shared between the
 * server (`lib/ai/path-d-stream-handler.ts` +
 * `app/api/projects/[projectId]/mapping/path-d/stream/route.ts`) and the
 * client EventSource consumer (B's territory, separate PR).
 *
 * ── Wire format ─────────────────────────────────────────────────────────────
 * Each event is serialised as a Server-Sent-Events (SSE) frame:
 *
 *   event: <kind>
 *   data: <JSON serialisation of the full event object>
 *   <empty line>
 *
 * The client's `EventSource` (or `fetch`-streaming) decoder recovers the
 * `kind` discriminator from either the SSE `event:` line OR the `kind`
 * field on the JSON payload — both are authoritative and identical. We
 * include `kind` in the JSON so consumers using a generic event-stream
 * reader (no `event:` parsing) still get a discriminated union back.
 *
 * ── Event-set rationale ─────────────────────────────────────────────────────
 * 5 event kinds covering the orchestrator's user-visible progress surface:
 *
 *   section_completed   — LLM finished writing a section's text (close tag
 *                         detected by the streaming parser). Preliminary
 *                         signal — parse status NOT YET known. See the
 *                         "section_completed vs section_persisted" note
 *                         below for the timing contract.
 *
 *   cost_update         — sampled output-token estimate + USD cost. Fired
 *                         every N text-deltas (orchestrator currently uses
 *                         50; see COST_CHECK_INTERVAL_DELTAS in
 *                         path-d-mapping.ts) — sub-second cadence at
 *                         typical streaming rates without thrashing the
 *                         event channel.
 *
 *   section_persisted   — persistence layer ran for this section. Carries
 *                         the AUTHORITATIVE status: 'inserted' (rows
 *                         landed in the DB), 'skipped' (parse_error or
 *                         missing section), or 'errored' (DB write
 *                         failed). When `section_completed` reported
 *                         that the section's text was assembled but the
 *                         JSON failed Zod validation, this event reports
 *                         status='skipped' with the parse-error message.
 *
 *   error               — terminal failure event. Phase identifies which
 *                         pipeline stage failed; message carries the
 *                         human-readable reason. Stream closes after
 *                         this event with no `done` to follow.
 *
 *   done                — final success event. runId carries the
 *                         experiment_run_id (matches `llm_calls.metadata`
 *                         + TFM `experiment_run_id` columns); summary is
 *                         the full PathDPersistResult that the
 *                         orchestrator returned. Stream closes after
 *                         this event.
 *
 * Events NOT in the protocol (and why):
 *
 *   section_started     — would require detecting open tags (`<mappings>`)
 *                         in the chunk stream. The parser only cheaply
 *                         exposes close-tag detection. Open-tag scanning
 *                         per chunk is costly relative to the marginal UX
 *                         benefit ("section is starting" is implicit from
 *                         the previous section's `section_completed`).
 *
 *   tokens_received     — redundant with `cost_update`, which already
 *                         carries the cumulative `outputTokens` count
 *                         alongside the cost figure.
 *
 * ── section_completed vs section_persisted — TIMING CONTRACT ────────────────
 *
 * IMPORTANT for client consumers: these two events report DIFFERENT moments
 * in the section's lifecycle and have DIFFERENT certainty about the
 * section's outcome.
 *
 * `section_completed` fires when the streaming parser detects the close
 * tag for that section (e.g., `</mappings>`). At this moment:
 *   • The LLM has finished writing the section's text.
 *   • The text is fully assembled in the parser's internal buffer.
 *   • Zod validation HAS NOT YET RUN. The parser only validates at
 *     `parser.finish()`, which fires once after the whole stream ends.
 *   • Therefore: the section's parse outcome is UNKNOWN at this moment.
 *
 * `section_persisted` fires after the orchestrator's persistence layer
 * has attempted to write the section's rows. At this moment:
 *   • Zod validation has run.
 *   • If validation passed, the persistence helper has run a DB write.
 *   • The status field carries the AUTHORITATIVE outcome:
 *       - 'inserted'  — rows successfully written, count = #rows
 *       - 'skipped'   — parse_error (Zod failed) OR missing section
 *                        (close tag never appeared); the section is
 *                        not in the database
 *       - 'errored'   — parse OK but DB write failed; error field
 *                        carries the PostgREST error message
 *
 * Two valid client-side patterns for surfacing section progress:
 *
 *   Pattern A — preliminary + confirmation (richer UX):
 *     section_completed: mappings  → render "Mappings detected" (grey,
 *                                     in-flight chip)
 *     section_persisted:            → if status='inserted', render
 *       mappings { status: 'inserted',  "Mappings saved (26)" (green,
 *                   count: 26 }         confirmed chip)
 *                                   → if status='skipped', render
 *                                     "Mappings parse failed" (red)
 *
 *   Pattern B — single source of truth (simpler):
 *     Ignore section_completed entirely; only update UI on
 *     section_persisted. Loses the preliminary signal but the UI
 *     never shows "detected" then "actually-failed" jitter.
 *
 * Either pattern works against the protocol. Pattern A gives the user
 * earlier feedback (section_completed lands during streaming, ~2-3
 * minutes earlier than section_persisted in worst case); Pattern B
 * gives consistent state at the cost of latency.
 *
 * ── Ordering guarantees ─────────────────────────────────────────────────────
 *
 * Within a single Path D run:
 *
 *   1. `cost_update` events may interleave anywhere during streaming.
 *   2. `section_completed` events fire in EMIT order from the LLM:
 *      mappings, coverage, decisions, lookup_tables, data_quality,
 *      inferred_targets, project_notes. (This matches the parser's
 *      `SECTION_NAMES` order.)
 *   3. `section_persisted` events fire in DEPENDENCY-INSERT order from
 *      the persistence layer (NOT emit order):
 *      data_quality → mappings → coverage → lookup_tables →
 *      inferred_targets → decisions → project_notes. See
 *      lib/ai/path-d-persistence.ts for why.
 *   4. `error` is terminal — no events follow.
 *   5. `done` is terminal — no events follow. Exactly one of `error` or
 *      `done` ends every successful stream open. (A client-cancelled
 *      stream may end with neither — see `Cancellation` below.)
 *
 * ── Cancellation ────────────────────────────────────────────────────────────
 *
 * If the client closes the connection mid-stream, the orchestrator's
 * AbortController cascades, persistence runs on whatever was parsed,
 * and the stream closes WITHOUT emitting a final `error` or `done`
 * event (the response is already gone). Clients should treat
 * "EventSource closed without `error` or `done`" as a cancellation.
 *
 * ── Section name vocabulary ─────────────────────────────────────────────────
 *
 * Mirrors the parser's `SECTION_NAMES` tuple. Re-exported here so client
 * consumers don't need a transitive dependency on `path-d-parser.ts`.
 */

import type { PathDPersistResult } from '@/lib/ai/path-d-persistence'

/**
 * The seven Path D sections, in the LLM's emit order. This vocabulary is
 * shared with the parser (`lib/ai/path-d-parser.ts:SECTION_NAMES`) and
 * the persistence layer (`lib/ai/path-d-persistence.ts:PathDPersistResult`).
 */
export type PathDSectionName =
  | 'mappings'
  | 'coverage'
  | 'decisions'
  | 'lookup_tables'
  | 'data_quality'
  | 'inferred_targets'
  | 'project_notes'

/**
 * Phase identifier for terminal `error` events. Each phase corresponds to
 * a stage of the orchestrator's pipeline; the phase tag tells the client
 * where to render the failure (precondition errors land at the top of
 * the page; persist errors land per-section; etc.).
 */
export type PathDErrorPhase =
  | 'precondition' // flag off, threshold exceeded, missing tables, missing auth
  | 'cost_ceiling' // pre-call OR mid-stream cost gate exceeded
  | 'parse' // unrecoverable parse error (most parse errors land per-section as 'skipped' on section_persisted instead)
  | 'persist' // persistPathDOutput threw uncaught
  | 'internal' // unexpected exception in the orchestrator's outer try/catch

/**
 * Per-section persist status. Mirrors `SectionPersistStatus` in
 * `lib/ai/path-d-persistence.ts` — re-exported as a string union here so
 * client consumers don't need to import the persistence module.
 */
export type PathDSectionPersistStatus = 'inserted' | 'skipped' | 'errored'

// ── Event variants ─────────────────────────────────────────────────────────

/**
 * The LLM finished writing this section's text (close tag detected by the
 * streaming parser). Preliminary signal — Zod parse status not yet known.
 * Confirmation arrives later as a matching `section_persisted` event.
 *
 * See the "section_completed vs section_persisted" timing contract in
 * the file header for the full semantic.
 */
export interface PathDSectionCompletedEvent {
  kind: 'section_completed'
  section: PathDSectionName
}

/**
 * Sampled cost update during streaming. The orchestrator samples every
 * N text-deltas (currently 50) and emits this event with the cumulative
 * output-token count plus the running USD cost estimate (input tokens
 * × $5/M + output tokens × $25/M, the actual Opus 4.7 pricing per
 * `lib/ai/pricing.ts`).
 *
 * Useful for live cost meters in the UI. The final authoritative cost
 * appears on `done.summary` (via the llm_calls row's cost_usd field
 * reachable through the runId).
 */
export interface PathDCostUpdateEvent {
  kind: 'cost_update'
  /** Cumulative output tokens consumed so far in this run. */
  outputTokens: number
  /** Running USD cost estimate (input + output, per Opus 4.7 pricing). */
  estimatedCostUsd: number
}

/**
 * Persistence layer ran for this section. Carries the authoritative
 * outcome:
 *   - `'inserted'`: DB rows written; `count` reports how many.
 *   - `'skipped'`: section was parse_error (Zod failed) or missing
 *     entirely; nothing in the DB.
 *   - `'errored'`: parse OK but DB write failed; `error` carries the
 *     PostgREST error message.
 *
 * `section_persisted` fires in dependency-insert order, NOT in the LLM's
 * emit order. See file-header "Ordering guarantees" for the exact
 * sequence.
 */
export interface PathDSectionPersistedEvent {
  kind: 'section_persisted'
  section: PathDSectionName
  status: PathDSectionPersistStatus
  /** Number of rows inserted (only present when status === 'inserted'). */
  count?: number
  /** PostgREST error message (only present when status === 'errored'). */
  error?: string
}

/**
 * Terminal error event. Stream closes after this event; no further events
 * (including `done`) follow.
 *
 * `phase` identifies which pipeline stage failed:
 *   - `'precondition'`: auth, permission, flag, threshold, missing tables
 *   - `'cost_ceiling'`: pre-call gate or mid-stream gate exceeded
 *   - `'parse'`: catastrophic parser failure (most parse errors land
 *     per-section as 'skipped' on `section_persisted`, not here)
 *   - `'persist'`: persistPathDOutput threw uncaught
 *   - `'internal'`: unexpected exception in the orchestrator's outer
 *     try/catch
 */
export interface PathDErrorEvent {
  kind: 'error'
  phase: PathDErrorPhase
  message: string
}

/**
 * Terminal success event. Carries the run's `experiment_run_id` and the
 * full PathDPersistResult (per-section status + count + error). After
 * this event the stream closes; no events follow.
 *
 * Clients that opted into Pattern B (ignore `section_completed`, only
 * update UI on `section_persisted`) can additionally read `summary`
 * here as a sanity check — it should match what they accumulated from
 * `section_persisted` events.
 */
export interface PathDDoneEvent {
  kind: 'done'
  runId: string
  summary: PathDPersistResult
}

/**
 * The full discriminated union. Exhaustive — adding a new event kind
 * requires adding it here AND updating the server emitter AND any
 * client consumer's switch statement.
 */
export type PathDEvent =
  | PathDSectionCompletedEvent
  | PathDCostUpdateEvent
  | PathDSectionPersistedEvent
  | PathDErrorEvent
  | PathDDoneEvent

/**
 * SSE-encode a single event for the wire. The format follows the SSE
 * spec exactly: `event:` line, `data:` line, terminated by an empty
 * line. The data payload is a single JSON object with no embedded
 * newlines (we rely on JSON.stringify NOT introducing newlines for
 * the event payloads we emit — verified for the 5 event variants).
 *
 * Returned as a Uint8Array because Next.js Route Handler ReadableStreams
 * enqueue bytes, not strings.
 */
export function encodePathDEvent(event: PathDEvent): Uint8Array {
  const payload = `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`
  return new TextEncoder().encode(payload)
}
