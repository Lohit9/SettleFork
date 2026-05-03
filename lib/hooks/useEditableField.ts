'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Discriminated result returned by the consumer's onSave callback.
 * Mirrors the {success, error?} shape used by the codebase's server
 * actions (see lib/actions/projects.ts and friends). ProfileCard's
 * updateProfileName throws-on-error instead of returning this shape;
 * the callsite wraps the throws in a try/catch adapter.
 */
export type SaveResult = { success: true } | { success: false; error: string }

export interface UseEditableFieldOptions {
  /** The committed value. Re-syncs to draft when not editing. */
  initialValue: string
  /** Called with the trimmed draft. Resolve with `{success}` shape; throws are
   *  caught and converted to `{success: false}` with the error message. */
  onSave: (draft: string) => Promise<SaveResult>
  /** Edit-toggle UX (default false): user clicks Edit, draft becomes editable,
   *  Save/Cancel commit/discard. Always-on UX (true): input always editable,
   *  Save button auto-disables when no changes. */
  alwaysEditing?: boolean
  /** Auto-dismiss the success flag after this many ms. Default 3000. Set to 0
   *  to disable auto-dismiss. */
  autoDismissSuccessMs?: number
  /** Optional success-message string. Returned via `successMessage` so the
   *  callsite can render `{field.successMessage && <p>...</p>}` without
   *  re-declaring. Pass nothing for silent-exit UX (ProfileCard). */
  successMessage?: string
  /** Optional callsite-specific side effect on successful save (e.g.,
   *  router.refresh, parent state sync). Receives the trimmed saved value. */
  onSuccess?: (newValue: string) => void
}

export interface UseEditableFieldReturn {
  isEditing: boolean
  draft: string
  error: string | null
  success: boolean
  isSaving: boolean
  /** True iff trimmed draft is non-empty AND differs from initialValue AND not currently saving. */
  canSave: boolean
  /** The configured successMessage, surfaced ONLY while `success` is true.
   *  null when either there is no active success or no message was configured. */
  successMessage: string | null
  setDraft: (next: string) => void
  /** Enter edit mode (no-op when alwaysEditing). Resets draft to initialValue,
   *  clears error/success. */
  startEdit: () => void
  /** Reset draft to initialValue and clear error/success. Exits edit mode
   *  unless alwaysEditing. */
  cancel: () => void
  /** Save the trimmed draft via onSave. No-op when !canSave. */
  save: () => Promise<void>
  /** Bind to an input's onKeyDown. Enter -> save (when canSave); Escape -> cancel.
   *  For multi-input clusters where Enter has different semantics, the callsite
   *  should handle keys itself instead of using this. */
  handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
}

/**
 * Lightweight editable-field state machine. Captures the
 * isEditing/draft/error/success/saving cycle shared by single-field
 * settings forms in the codebase.
 *
 * Use for: single text-input fields with a {success, error} server
 * action, no toast, no client-side Zod, no react-hook-form. The
 * intentionally minimal pattern.
 *
 * Two UX modes:
 * - Edit-toggle (default): user clicks Edit, draft becomes editable,
 *   Save/Cancel commit/discard. Used by ProfileCard.
 * - Always-on (alwaysEditing: true): input always editable, Save
 *   button auto-disables when no changes. Used by OrganizationSettings.
 *
 * NOT for: multi-field forms with sequential save semantics (see
 * InfoTab — three fields, sequential save, abort-on-first-failure).
 * When a second multi-field caller appears, design a
 * useEditableFieldGroup hook with sequencing semantics built in.
 */
export function useEditableField(
  options: UseEditableFieldOptions,
): UseEditableFieldReturn {
  const {
    initialValue,
    onSave,
    alwaysEditing = false,
    autoDismissSuccessMs = 3000,
    successMessage,
    onSuccess,
  } = options

  const [editing, setEditing] = useState<boolean>(alwaysEditing)
  const [draft, setDraft] = useState<string>(initialValue)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<boolean>(false)
  const [saving, setSaving] = useState<boolean>(false)

  // Re-sync draft when initialValue changes AND user isn't editing.
  // For Edit-toggle mode, "not editing" means !editing (the toggle is off).
  // For always-on mode, the input is always live; we only re-sync when the
  // current draft equals the previous initialValue (unedited) — but tracking
  // "previous" requires a ref. Simpler heuristic: in always-on mode, never
  // clobber the draft. The callsite is expected to control the lifecycle.
  useEffect(() => {
    if (!alwaysEditing && !editing) {
      setDraft(initialValue)
    }
  }, [initialValue, editing, alwaysEditing])

  // Auto-dismiss the success flag after the configured delay.
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!success || autoDismissSuccessMs <= 0) return
    successTimerRef.current = setTimeout(() => setSuccess(false), autoDismissSuccessMs)
    return () => {
      if (successTimerRef.current) {
        clearTimeout(successTimerRef.current)
        successTimerRef.current = null
      }
    }
  }, [success, autoDismissSuccessMs])

  const trimmedDraft = draft.trim()
  const canSave = !saving && trimmedDraft !== '' && trimmedDraft !== initialValue

  const startEdit = () => {
    if (alwaysEditing) return
    setDraft(initialValue)
    setError(null)
    setSuccess(false)
    setEditing(true)
  }

  const cancel = () => {
    setDraft(initialValue)
    setError(null)
    setSuccess(false)
    if (!alwaysEditing) setEditing(false)
  }

  const save = async (): Promise<void> => {
    if (!canSave) return
    setError(null)
    setSuccess(false)
    setSaving(true)
    let result: SaveResult
    try {
      result = await onSave(trimmedDraft)
    } catch (err) {
      result = {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to save',
      }
    }
    setSaving(false)
    if (!result.success) {
      setError(result.error)
      return
    }
    setError(null)
    setSuccess(true)
    onSuccess?.(trimmedDraft)
    if (!alwaysEditing) setEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && canSave) {
      e.preventDefault()
      void save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  return {
    isEditing: editing,
    draft,
    error,
    success,
    isSaving: saving,
    canSave,
    successMessage: success ? (successMessage ?? null) : null,
    setDraft,
    startEdit,
    cancel,
    save,
    handleKeyDown,
  }
}
