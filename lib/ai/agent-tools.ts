/**
 * PR 3.3 — Handler factories for the 3 data-scanning agent tools.
 *
 * Each factory wraps a Postgres RPC (migration 085) into the
 * `ToolHandler` contract from `lib/ai/agent-loop.ts`. Adopting
 * callsites (PR 3.4+) register {tool, handler} pairs:
 *
 *   const handlers = [
 *     { tool: QUERY_FIELD_DATA_TOOL,
 *       handler: makeQueryFieldDataHandler({ supabase, projectId, userId }) },
 *     { tool: COUNT_DISTINCT_PATTERNS_TOOL,
 *       handler: makeCountDistinctPatternsHandler({ supabase, projectId, userId }) },
 *     { tool: CROSS_FIELD_CORRELATION_TOOL,
 *       handler: makeCrossFieldCorrelationHandler({ supabase, projectId, userId }) },
 *     { tool: ANSWER_TOOL }, // no handler = answer tool
 *   ]
 *
 * The `supabase` client must carry the calling user's JWT (via
 * `createClient()` cookies path or eval-runner's signed JWT). The
 * RPCs are SECURITY INVOKER — they verify access via
 * user_has_project_role(p_project_id, 'viewer') against auth.uid()
 * extracted from the JWT. Service-role clients DO NOT have a JWT
 * and will fail the gate; callers must pass a user-authed client.
 *
 * Error classification (per design §A6):
 *   - 'Access denied' / 'Table not in project': fatal=true. The
 *     model can't recover from RLS violations; the loop aborts with
 *     reason='tool_error'.
 *   - 'Unsafe where_filter' (B1 only): fatal=false. The model can
 *     retry with a different filter shape.
 *   - Statement timeout: fatal=false. The model can retry with a
 *     smaller scope (e.g., filter to fewer rows).
 *   - Other RPC errors: fatal=false with the error message in result.
 *   - Validation failures (caught client-side before the RPC call):
 *     fatal=false; the model retries with valid args.
 *
 * Spec: docs/investigations/pr-phase3.1-agent-design.md §B + §A3.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

import type { ToolHandler } from '@/lib/ai/agent-loop'

// ─── Public factory dependencies ────────────────────────────────────────────

export interface AgentToolDeps {
  /**
   * Supabase client carrying the calling user's JWT (NOT service-role).
   * The RPCs are SECURITY INVOKER and verify access via
   * `user_has_project_role(p_project_id, 'viewer')` against auth.uid().
   */
  supabase: SupabaseClient
  projectId: string
  /** For telemetry only; the RPC reads auth.uid() from the JWT. */
  userId: string
}

// ─── Validation helpers ──────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FIELD_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

function validateUuid(value: unknown, fieldName: string): string | { error: string } {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    return { error: `${fieldName} must be a UUID string` }
  }
  return value
}

function validateFieldName(
  value: unknown,
  fieldName: string,
): string | { error: string } {
  if (typeof value !== 'string' || value.length === 0) {
    return { error: `${fieldName} must be a non-empty string` }
  }
  if (!FIELD_NAME_RE.test(value)) {
    return { error: `${fieldName} must be a bare identifier (alphanumeric + underscore, no JSONB operators)` }
  }
  return value
}

function isValidationError(v: unknown): v is { error: string } {
  return typeof v === 'object' && v !== null && 'error' in v
}

// ─── Error classification ────────────────────────────────────────────────────

interface ClassifiedError {
  result: string
  fatal: boolean
}

/**
 * Map a Supabase RPC error to the ToolHandler return shape per
 * design §A6. RLS violations terminate the loop; everything else is
 * retryable so the model can adjust its args.
 */
function classifyRpcError(err: unknown, toolName: string): ClassifiedError {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : String(err)

  // RLS violations → fatal
  if (/access denied/i.test(message) || /table not in project/i.test(message)) {
    return {
      result: JSON.stringify({ error: `${toolName} denied: ${message}` }),
      fatal: true,
    }
  }

  // where_filter rejection (B1) → retryable
  if (/unsafe where_filter/i.test(message)) {
    return {
      result: JSON.stringify({
        error:
          'where_filter rejected by safety allowlist. Use a single column condition like "row_data->>\'field\' IS NULL" or "row_data->>\'status\' = \'active\'". Avoid JOIN, UNION, multiple conditions, or DDL/DML keywords.',
      }),
      fatal: false,
    }
  }

  // Statement timeout → retryable with smaller scope
  if (/statement timeout/i.test(message) || /canceling statement/i.test(message)) {
    return {
      result: JSON.stringify({
        error: `${toolName} timed out. Retry with a tighter filter or a smaller limit.`,
      }),
      fatal: false,
    }
  }

  // Invalid field/identifier → retryable
  if (/invalid field/i.test(message) || /must be a bare identifier/i.test(message)) {
    return {
      result: JSON.stringify({ error: `${toolName} rejected the field name: ${message}` }),
      fatal: false,
    }
  }

  // Generic RPC error → retryable
  return {
    result: JSON.stringify({ error: `${toolName} failed: ${message}` }),
    fatal: false,
  }
}

// ─── B1: query_field_data handler ────────────────────────────────────────────

export function makeQueryFieldDataHandler(deps: AgentToolDeps): ToolHandler {
  return async (input) => {
    // Validate input
    const tableId = validateUuid(input.table_id, 'table_id')
    if (isValidationError(tableId)) {
      return { result: JSON.stringify(tableId), fatal: false }
    }
    const fieldName = validateFieldName(input.field_name, 'field_name')
    if (isValidationError(fieldName)) {
      return { result: JSON.stringify(fieldName), fatal: false }
    }
    const whereFilter =
      typeof input.where_filter === 'string' ? input.where_filter : null
    const limit =
      typeof input.limit === 'number' && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(50, Math.floor(input.limit)))
        : 20

    try {
      const { data, error } = await deps.supabase.rpc('agent_query_field_data', {
        p_project_id: deps.projectId,
        p_table_id: tableId,
        p_field_name: fieldName,
        p_where_filter: whereFilter,
        p_limit: limit,
      })
      if (error) throw error
      return {
        result: JSON.stringify(data),
        metadata: {
          tool: 'query_field_data',
          table_id: tableId,
          field_name: fieldName,
          limit,
          ...(whereFilter ? { where_filter: whereFilter } : {}),
          user_id: deps.userId,
        },
      }
    } catch (err) {
      return classifyRpcError(err, 'query_field_data')
    }
  }
}

// ─── B2: count_distinct_patterns handler ─────────────────────────────────────

export function makeCountDistinctPatternsHandler(deps: AgentToolDeps): ToolHandler {
  return async (input) => {
    const tableId = validateUuid(input.table_id, 'table_id')
    if (isValidationError(tableId)) {
      return { result: JSON.stringify(tableId), fatal: false }
    }
    const fieldName = validateFieldName(input.field_name, 'field_name')
    if (isValidationError(fieldName)) {
      return { result: JSON.stringify(fieldName), fatal: false }
    }
    const limit =
      typeof input.limit === 'number' && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(30, Math.floor(input.limit)))
        : 15

    try {
      const { data, error } = await deps.supabase.rpc(
        'agent_count_distinct_patterns',
        {
          p_project_id: deps.projectId,
          p_table_id: tableId,
          p_field_name: fieldName,
          p_limit: limit,
        },
      )
      if (error) throw error
      return {
        result: JSON.stringify(data),
        metadata: {
          tool: 'count_distinct_patterns',
          table_id: tableId,
          field_name: fieldName,
          limit,
          user_id: deps.userId,
        },
      }
    } catch (err) {
      return classifyRpcError(err, 'count_distinct_patterns')
    }
  }
}

// ─── B3: cross_field_correlation handler ─────────────────────────────────────

export function makeCrossFieldCorrelationHandler(deps: AgentToolDeps): ToolHandler {
  return async (input) => {
    const tableId = validateUuid(input.table_id, 'table_id')
    if (isValidationError(tableId)) {
      return { result: JSON.stringify(tableId), fatal: false }
    }
    const fieldAName = validateFieldName(input.field_a_name, 'field_a_name')
    if (isValidationError(fieldAName)) {
      return { result: JSON.stringify(fieldAName), fatal: false }
    }
    const fieldBName = validateFieldName(input.field_b_name, 'field_b_name')
    if (isValidationError(fieldBName)) {
      return { result: JSON.stringify(fieldBName), fatal: false }
    }

    try {
      const { data, error } = await deps.supabase.rpc(
        'agent_cross_field_correlation',
        {
          p_project_id: deps.projectId,
          p_table_id: tableId,
          p_field_a_name: fieldAName,
          p_field_b_name: fieldBName,
        },
      )
      if (error) throw error
      return {
        result: JSON.stringify(data),
        metadata: {
          tool: 'cross_field_correlation',
          table_id: tableId,
          field_a_name: fieldAName,
          field_b_name: fieldBName,
          user_id: deps.userId,
        },
      }
    } catch (err) {
      return classifyRpcError(err, 'cross_field_correlation')
    }
  }
}
