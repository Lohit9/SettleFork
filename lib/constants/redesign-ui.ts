// ─────────────────────────────────────────────────────────────────────────────
// Mapping redesign — shared UI constants.
// ─────────────────────────────────────────────────────────────────────────────
//
// Constants consumed by multiple sibling components in the redesign-side
// Mapping page. Kept as a flat module to avoid sibling-imports across
// component files (e.g. `SourceFieldPicker` reaching into
// `SourceSchemaSidebar` for a debounce value would be upside-down — both
// are peers).
//
// Add a constant here only when:
//   • Two or more components in `app/app/projects/[projectId]/mapping/redesign`
//     consume the same value, AND
//   • The value is purely a UI tuning knob (no business semantics).
//
// Per-component constants (e.g. `MAPPING_DRAWER_WIDTH_PX`,
// `SIDEBAR_COLLAPSED_WIDTH_PX`) stay colocated with their component.

/**
 * Debounce window for free-text search inputs in the redesign Mapping
 * UI — applied between keystroke and filter-pipeline propagation.
 *
 * Used by:
 *   • `MappingContent.tsx` (main-view filter row search) — Phase 3 Gap 3
 *   • `SourceSchemaSidebar.tsx` — Phase 3 Gap 11b
 *   • `SourceFieldPicker.tsx` — Phase 4a-2
 *
 * 200 ms feels instant to a human typing while still collapsing
 * burst keystrokes into a single filter pass. If smoke-tester
 * feedback ever asks for snappier feedback, lower this value here
 * (single source of truth) and not at any individual call site.
 */
export const SEARCH_DEBOUNCE_MS = 200

/**
 * Auto-dismiss timeout for toast notifications — applied between toast
 * push and automatic removal from the queue. Manual dismissal (via the
 * close button or a programmatic `dismissToast(id)` call) bypasses this.
 *
 * Used by:
 *   • `lib/contexts/ToastContext.tsx` (Phase 4a-4a)
 *   • `MappingContent.tsx` row-switch-while-dirty notification (Phase 4a-4a)
 *
 * 5 seconds is long enough to read a short notification ("Mapping draft
 * discarded") and click an action affordance ("Undo"), and short enough
 * to not block the user's next interaction. Matches the OS-level toast
 * convention (macOS, iOS, Android notification timeouts cluster in the
 * 4–6s range).
 */
export const TOAST_AUTO_DISMISS_MS = 5000

/**
 * Maximum number of simultaneously visible toasts. When the queue
 * exceeds this count, the oldest toast is evicted (FIFO). Replace-by-id
 * semantics (`pushToast({ id })` re-using an existing id) does NOT
 * consume a slot — the previous toast with the same id is replaced
 * in place.
 *
 * 3 keeps the bottom-right stack readable without crowding the drawer's
 * sticky footer. Increase only if smoke-tester feedback shows users
 * missing notifications during burst events.
 */
export const TOAST_MAX_VISIBLE = 3
