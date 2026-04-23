'use server'

import { supabaseAdmin } from '@/lib/supabase/admin'

export type SSOAuditEventType =
  | 'sso.provider.configured'
  | 'sso.provider.updated'
  | 'sso.provider.removed'
  | 'sso.enforcement.changed'
  | 'sso.domain.added'
  | 'sso.domain.removed'
  | 'sso.login.success'
  | 'sso.login.failure'
  | 'sso.jit.provisioned'
  | 'sso.identity.linked'
  | 'sso.identity.unlinked'

/**
 * Emit an SSO audit event.
 *
 * Never throws. Parent action proceeds regardless of audit
 * write success. Failures are logged for manual reconciliation
 * with a grep-able anchor.
 *
 * When the unified audit_log table (item 1.B) ships, events
 * written here will be migrated and this helper will be
 * refactored to write to the unified table.
 */
export async function emitSsoAuditEvent(
  eventType: SSOAuditEventType,
  context: {
    actorUserId?: string | null
    orgId?: string | null
    metadata?: Record<string, unknown>
  }
): Promise<void> {
  try {
    const { error } = await supabaseAdmin
      .from('sso_audit_events')
      .insert({
        event_type: eventType,
        actor_user_id: context.actorUserId ?? null,
        org_id: context.orgId ?? null,
        metadata: context.metadata ?? {},
      })
    if (error) {
      console.error(
        '[sso-audit] emit failed — parent action will proceed',
        {
          eventType,
          orgId: context.orgId,
          error: error.message,
        }
      )
    }
  } catch (err) {
    console.error(
      '[sso-audit] emit threw — parent action will proceed',
      { eventType, orgId: context.orgId, err: String(err) }
    )
  }
}
