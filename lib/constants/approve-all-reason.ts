/**
 * Sentinel `target_field_mappings.acknowledgment_reason` written by the
 * legacy bulk "approve all" path (`approveAllFieldMappings` in
 * `lib/actions/mappings.ts`) when it acknowledges an unmapped target
 * field as a deliberate user decision.
 *
 * It is the discriminator the target-field-swap conflict check uses to
 * tell a *genuine user acknowledgment* apart from a *static-provider
 * bare-ack*. Both produce a `target_field_mappings` row with
 * `is_acknowledged=true` and `combination_type=NULL`, but:
 *   • user "approve all"  → `acknowledgment_reason = APPROVE_ALL_REASON`
 *   • static-provider     → `acknowledgment_reason = <JSON rationale>`
 *
 * The distinction matters because a bare-ack must NOT block a target
 * swap (it carries no user decision), whereas a genuine user-ack must.
 *
 * Lives in this standalone, non-`'use server'` module because both a
 * Server Actions file (`lib/actions/mappings.ts`) and the redesign
 * action surface (`lib/actions/mappings-for-redesign.ts`) import it —
 * a `'use server'` file may only export async functions.
 */
export const APPROVE_ALL_REASON = 'approved_via_approve_all'
