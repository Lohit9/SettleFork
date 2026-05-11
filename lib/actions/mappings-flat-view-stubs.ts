/**
 * TEMPORARY STUBS for the Mapping list view's server actions.
 *
 * These mirror the action signatures agreed with the parallel
 * server-side investigation (A's PR
 * `feat/spreadsheet-view-server-actions`). They throw a clear runtime
 * error if invoked so the UI build does not silently misbehave.
 *
 * REMOVAL PLAN
 * ────────────
 * Before opening the UI PR (`feat/spreadsheet-view-toggle-ui`):
 *   1. Wait for A's PR to merge.
 *   2. Delete this file.
 *   3. Update every importer (search the repo for
 *      `mappings-flat-view-stubs`) to import from the canonical
 *      action module A ships — likely `@/lib/actions/mappings-for-redesign`.
 *   4. Re-run typecheck + tests.
 *
 * Until removal, this file documents the contract the UI assumes.
 * Any divergence A reports in their investigation gets reconciled
 * here first, then propagated through the importers — the action
 * shape is a single seam.
 */

'use server'

import type { MappingActionResult } from '@/lib/actions/mappings-for-redesign'

const NOT_WIRED =
  'Mapping list view action is not yet wired to a server implementation. ' +
  "Replace 'lib/actions/mappings-flat-view-stubs' imports with the canonical " +
  "server actions from A's PR before opening the UI PR."

/**
 * Swap one source attribution's source field while keeping the rest of
 * the TFM intact.
 *
 *   • `rowId` is the shimmed contributor id `<tfmId>::<mappingSourceId>`
 *     (matches the existing approve/reject convention).
 *   • Auto-approves the parent TFM at confidence=1.0, status='approved',
 *     statusSetBy='user' (founder lock — all manual interactions
 *     auto-approve the whole TFM).
 */
export async function updateMappingSourceField(
  _rowId: string,
  _newSourceFieldId: string,
): Promise<MappingActionResult> {
  throw new Error(NOT_WIRED)
}

/**
 * Swap a TFM's target field. Multi-source TFMs carry all their sources
 * along to the new target. The behavior when the destination target
 * already has its own TFM is owned by A's server action — the UI
 * surfaces whatever error message comes back.
 *
 * Auto-approves at confidence=1.0, status='approved', statusSetBy='user'.
 */
export async function updateMappingTargetField(
  _tfmId: string,
  _newTargetFieldId: string,
): Promise<MappingActionResult> {
  throw new Error(NOT_WIRED)
}

/**
 * Create a new TFM from an unmapped target row OR unmapped source row.
 * Either flow funnels through one action; the caller passes both ids
 * derived from the row + the picker selection.
 *
 * New TFM lands with status='approved', confidence=1.0,
 * statusSetBy='user' — manual mapping creation auto-approves
 * (founder lock).
 */
export async function createMappingFromUnmapped(
  _args: { sourceFieldId: string; targetFieldId: string },
): Promise<MappingActionResult> {
  throw new Error(NOT_WIRED)
}

/**
 * Mark an unmapped row as explicitly rejected (gray-dot state). Works
 * symmetrically for both axes:
 *   • `{ targetFieldId }` → updates coverage row's status to 'rejected'
 *   • `{ sourceFieldId }` → server-owned semantics (per A's design,
 *     likely updates `source_field_acknowledgments` or a sibling
 *     table; out of scope for this UI stub).
 */
export async function setUnmappedRowRejected(
  _args: { targetFieldId: string } | { sourceFieldId: string },
): Promise<MappingActionResult> {
  throw new Error(NOT_WIRED)
}
