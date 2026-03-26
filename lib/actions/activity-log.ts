'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

export type ActionType =
  | 'fix_applied'
  | 'fix_reverted'
  | 'custom_fix_applied'
  | 'risk_accepted'
  | 'risk_reverted'
  | 'transform_generated'
  | 'transform_tested'
  | 'transform_applied'
  | 'mapping_approved'
  | 'mapping_rejected'
  | 'mapping_generated'
  | 'rule_added'
  | 'rule_deleted'
  | 'scan_run'
  | 'stage_all'
  | 'source_uploaded'
  | 'target_uploaded'
  | 'doc_uploaded'

export type ActionCategory = 'fix' | 'mapping' | 'transform' | 'validation' | 'data' | 'system'

/**
 * Append one activity entry to the log. Always fire-and-forget — wrapped in
 * try/catch so a logging failure never blocks the parent server action.
 */
export async function logActivity(
  projectId: string,
  actionType: ActionType,
  description: string,
  category: ActionCategory,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return

    await supabaseAdmin.from('activity_log').insert({
      project_id: projectId,
      user_id: user.id,
      action_type: actionType,
      description,
      category,
      metadata: metadata ?? {},
    })
  } catch (err) {
    // Non-critical — never fail the parent action because of logging
    console.warn('[activity-log] Failed to log activity:', err)
  }
}
