'use server'

/**
 * Deliverable download URL refresh.
 *
 * The Migration Center persists generated deliverables in the `outputs` table
 * and in the `project-files` storage bucket. Signed URLs returned at
 * generation time (or rehydrated during SSR of the Outputs page) expire after
 * one hour. This server action mints a fresh signed URL on demand so that
 * Download buttons remain durable across long sessions, tab restores, and
 * day-old browser windows.
 *
 * Security model:
 *  - Anon Supabase client validates the session via cookies.
 *  - A lightweight RLS-gated `projects` lookup confirms the caller has
 *    access to the project before we touch `supabaseAdmin`.
 *  - Only after that gate do we use the service-role client to read the
 *    `outputs` row (which lives outside RLS for service operations) and
 *    sign the URL. This mirrors the pattern established by
 *    `getExecutionPackageUrl` in `lib/actions/execution-package.ts`.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

// UI-side deliverable keys in the format `<type>_<format>`. Keeping the union
// here (rather than importing a shared constant) avoids a circular dep with
// the client component and lets the type narrow exhaustiveness at the switch.
export type DeliverableKey =
  | 'runbook_docx'
  | 'readiness_report'
  | 'mapping_csv'
  | 'mapping_json'
  | 'transform_specs'
  | 'fix_log'
  | 'data_dictionary'

interface OutputLookup {
  type: string
  format: string
}

// Maps a UI deliverable key to the (type, format) tuple stored in the
// `outputs` table. Exhaustive by construction — the TypeScript `never` cast
// at the end guarantees a compile error if a new DeliverableKey is added
// without a corresponding mapping.
function resolveOutputLookup(key: DeliverableKey): OutputLookup {
  switch (key) {
    case 'runbook_docx':     return { type: 'migration_runbook',     format: 'docx' }
    case 'readiness_report': return { type: 'readiness_report',      format: 'docx' }
    case 'mapping_csv':      return { type: 'mapping_file',          format: 'csv' }
    case 'mapping_json':     return { type: 'mapping_file',          format: 'json' }
    case 'transform_specs':  return { type: 'transformation_specs',  format: 'sql' }
    case 'fix_log':          return { type: 'fix_log',               format: 'csv' }
    case 'data_dictionary':  return { type: 'data_dictionary',       format: 'csv' }
    default: {
      const _exhaustive: never = key
      throw new Error(`Unhandled deliverable key: ${String(_exhaustive)}`)
    }
  }
}

export interface GetDeliverableUrlResult {
  url?: string
  version?: string
  generatedAt?: string
  error?: string
}

/**
 * Returns a freshly signed 1-hour download URL for the latest generation of
 * a given deliverable. Returns `{ error }` if the caller is unauthenticated,
 * lacks project access, has never generated the deliverable, or if signing
 * fails. Never throws on a missing deliverable — surfaces it as an error
 * string so the UI can render a graceful message.
 */
export async function getDeliverableUrl(
  projectId: string,
  key: DeliverableKey
): Promise<GetDeliverableUrlResult> {
  // ── Auth ─────────────────────────────────────────────────────────────────
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  // ── Project access (RLS) ────────────────────────────────────────────────
  // A viewer-level role is sufficient to *download* an existing deliverable.
  // Regeneration is gated by the generate server actions themselves (editor+).
  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .single()
  if (!project) return { error: 'Access denied' }

  // ── Lookup latest output ────────────────────────────────────────────────
  const { type, format } = resolveOutputLookup(key)

  const { data: output, error: outputErr } = await supabaseAdmin
    .from('outputs')
    .select('file_storage_path, version, generated_at')
    .eq('project_id', projectId)
    .eq('type', type)
    .eq('format', format)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (outputErr) return { error: 'Failed to look up deliverable' }
  if (!output?.file_storage_path) {
    return { error: 'No generated file found — please regenerate this deliverable.' }
  }

  // ── Sign URL ────────────────────────────────────────────────────────────
  const { data: signed, error: signErr } = await supabaseAdmin.storage
    .from('project-files')
    .createSignedUrl(output.file_storage_path, 3600)

  if (signErr || !signed?.signedUrl) {
    return { error: 'Failed to generate download URL' }
  }

  return {
    url: signed.signedUrl,
    version: output.version,
    generatedAt: output.generated_at,
  }
}
