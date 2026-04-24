'use server'

/**
 * Server-action read path for the Phase 3 redesigned Mapping page.
 *
 * Thin wrapper: auth-gate via `createClient()` + delegate to
 * `getMappingsForRedesignCore(supabase, projectId)` in
 * `_mappings-for-redesign-core.ts`. All business logic — query plan,
 * discriminator derivation, join-annotation inference, counter rollup
 * — lives in the core module, which is directly testable without the
 * Next.js request scope.
 *
 * Coexistence (design §8.2): this action lives ALONGSIDE the legacy
 * `getMappings` read path during Phase 3+4. The `mapping/page.tsx`
 * server component picks which action to call based on the
 * `projects.use_mapping_redesign` flag — both are callable in parallel
 * but a given render chooses exactly one.
 *
 * Deletable in Phase 5 only after the legacy UI is retired.
 */

import { createClient } from '@/lib/supabase/server'
import {
  getMappingsForRedesignCore,
} from '@/lib/actions/_mappings-for-redesign-core'
import type { MappingsForRedesignResult } from '@/lib/types/mappings-for-redesign'

export async function getMappingsForRedesign(
  projectId: string,
): Promise<MappingsForRedesignResult | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  return getMappingsForRedesignCore(supabase, projectId)
}
