'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4a-2 — W1 manual mapping creation form.
// ─────────────────────────────────────────────────────────────────────────────
//
// In-drawer inline form that lets a user create a `target_field_mapping`
// for a Rule 6 unmapped target field (founder decision 1: in-drawer
// inline, no modal). Composed of:
//
//   1. SourceFieldPicker         — chip strip + search + grouped list
//   2. CombinationStrategyRadios — visible only when 2+ sources picked
//   3. SamplePreview             — real-time client-side preview
//
// The drawer parent renders the visible [Cancel] [Save] buttons in the
// drawer footer; the form exposes its imperative save trigger via a
// `forwardRef` handle so the parent can fire it without owning the
// form's internal state shape.
//
// SAVE FLOW
//
//   `useTransition` wraps the call to `createFieldMapping`. On success
//   we yield `tfmId` to the parent via `onSaveSuccess` so it can flip
//   the drawer URL param and trigger `router.refresh()`. On failure we
//   surface a curated error string above the picker; the form stays
//   mounted so the user can correct + retry.
//
// EXISTING_TFM AFFORDANCE
//
//   Per founder decision §3-OQ-1, the wrapper's existing-TFM collision
//   error renders an inline [Refresh] button. Clicking it triggers a
//   `router.refresh()` and dismisses the form via `onCancel` so the
//   user lands on the freshly-rendered server state.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  useTransition,
} from 'react'
import { useRouter } from 'next/navigation'
import { AlertCircle } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { cn } from '@/components/ui/utils'
import {
  createFieldMapping,
  type CreateFieldMappingErrorCode,
  type CreateFieldMappingCombinationType,
} from '@/lib/actions/mappings-for-redesign'
import {
  computeSamplePreview,
  type SamplePreviewCombinationType,
} from '@/lib/utils/mapping-preview'
import type { SourceFieldWithState } from '@/lib/types/mappings-for-redesign'
import { SourceFieldPicker } from './SourceFieldPicker'

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * Imperative handle exposed by `CreateMappingForm` to its parent
 * (`MappingDrawer`). The parent owns the visible footer buttons; the
 * handle lets it dispatch into the form without lifting the form's
 * internal state shape.
 */
export interface CreateMappingFormHandle {
  /**
   * Trigger the save flow as if the user clicked the (parent-rendered)
   * Save button. No-op when already saving or when nothing is selected.
   */
  triggerSave: () => void
  /**
   * Tell the form the user wants to close (Esc / X / click-outside /
   * Cancel). When dirty the form opens its own discard dialog and
   * resolves to `onCancel()` only after the user confirms. When clean
   * the form invokes `onCancel()` immediately.
   */
  requestClose: () => void
}

export interface CreateMappingFormProps {
  projectId: string
  /**
   * The Rule 6 unmapped target field this form will create a TFM for.
   * Only `id` is required for the wrapper call; `name` is rendered in
   * the discard-dialog body for context.
   */
  targetField: { id: string; name: string }
  /**
   * Page-level source fields in canonical server order. Picker filters
   * and same-table-constrains in-line.
   */
  availableSourceFields: SourceFieldWithState[]
  /**
   * Called with the new TFM id once `createFieldMapping` succeeds.
   * Parent is expected to update the drawer URL param and call
   * `router.refresh()` so the row morphs from Rule 6 to Rule 1/2.
   */
  onSaveSuccess: (newTfmId: string) => void
  /**
   * Called when the user cancels (clean form OR after confirming
   * discard). Parent typically clears `isFormActive` so the drawer
   * body returns to the Rule 6 empty state.
   */
  onCancel: () => void
  /**
   * Notifies the parent (drawer) whenever the dirty flag flips so the
   * drawer's close-with-confirm intercept and the footer's Save-button
   * disabled state can read a single source of truth.
   */
  onStateChange?: (state: { isDirty: boolean; canSave: boolean; isSavePending: boolean }) => void
}

// ── Defaults / mappings ──────────────────────────────────────────────────────

const DEFAULT_COMBINATION_TYPE: CreateFieldMappingCombinationType = 'concat_space'

const ERROR_CODE_COPY: Record<CreateFieldMappingErrorCode, string> = {
  PERMISSION_DENIED:
    "You don't have permission to create mappings on this project.",
  NOT_FOUND: "Couldn't create the mapping. Please refresh and try again.",
  VALIDATION:
    "Couldn't create the mapping. Please check your selections and try again.",
  MAINTENANCE_MODE:
    'Mapping changes are temporarily disabled. Please try again in a moment.',
  INTERNAL: "Couldn't create the mapping. Please try again.",
  CROSS_TABLE_NOT_YET_SUPPORTED:
    'Cross-table mappings ship in Phase 4a-3. Please pick sources from a single source table.',
  CROSS_TABLE_AMBIGUOUS:
    "We couldn't infer a join automatically. Cross-table support arrives in Phase 4a-3.",
}

const EXISTING_TFM_COPY =
  'This target field was mapped while you were editing. Refresh to see the current state.'

// ── Component ────────────────────────────────────────────────────────────────

export const CreateMappingForm = forwardRef<
  CreateMappingFormHandle,
  CreateMappingFormProps
>(function CreateMappingForm(
  {
    projectId,
    targetField,
    availableSourceFields,
    onSaveSuccess,
    onCancel,
    onStateChange,
  },
  ref,
) {
  const router = useRouter()
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [combinationType, setCombinationType] =
    useState<CreateFieldMappingCombinationType>(DEFAULT_COMBINATION_TYPE)
  const [isSavePending, startSaveTransition] = useTransition()
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<CreateFieldMappingErrorCode | null>(
    null,
  )
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false)

  // ── Derived flags ───────────────────────────────────────────────
  const isDirty = selectedIds.length > 0
  const canSave = selectedIds.length > 0 && !isSavePending

  useEffect(() => {
    onStateChange?.({ isDirty, canSave, isSavePending })
  }, [isDirty, canSave, isSavePending, onStateChange])

  // ── Effective combination — collapses to 'single' for 1 source ───
  // The wrapper expects `'single'` when there is exactly one source;
  // the user's stored concat selection only matters once a second
  // source is added. The radio group is hidden for <2 sources, so the
  // user never observes this flip directly.
  const effectiveCombinationType: CreateFieldMappingCombinationType =
    selectedIds.length <= 1 ? 'single' : combinationType

  // ── Sample preview ──────────────────────────────────────────────
  const selectedFields = useMemo<SourceFieldWithState[]>(() => {
    const map = new Map<string, SourceFieldWithState>()
    for (const f of availableSourceFields) map.set(f.id, f)
    const out: SourceFieldWithState[] = []
    for (const id of selectedIds) {
      const f = map.get(id)
      if (f) out.push(f)
    }
    return out
  }, [selectedIds, availableSourceFields])

  const previewCombination: SamplePreviewCombinationType =
    effectiveCombinationType
  const samplePreview = useMemo(
    () => computeSamplePreview(selectedFields, previewCombination),
    [selectedFields, previewCombination],
  )

  // ── Selection / combination handlers ─────────────────────────────
  const handleSelectedChange = (next: string[]) => {
    setSelectedIds(next)
    if (errorMessage !== null) {
      setErrorMessage(null)
      setErrorCode(null)
    }
  }

  // ── Save flow ───────────────────────────────────────────────────
  const handleSave = () => {
    if (selectedIds.length === 0 || isSavePending) return
    setErrorMessage(null)
    setErrorCode(null)
    startSaveTransition(async () => {
      try {
        const result = await createFieldMapping({
          projectId,
          targetFieldId: targetField.id,
          sourceFieldIds: selectedIds,
          combinationType: effectiveCombinationType,
        })
        if (!result.success) {
          // EXISTING_TFM is a special VALIDATION case — the wrapper
          // returns errorCode='VALIDATION' with a stable phrase baked
          // into `error`. Sniff for the canonical phrase to surface
          // the inline [Refresh] affordance.
          const isExistingTfm =
            result.errorCode === 'VALIDATION' &&
            typeof result.error === 'string' &&
            result.error.toLowerCase().includes('mapped while you were editing')
          setErrorCode(result.errorCode)
          setErrorMessage(
            isExistingTfm
              ? EXISTING_TFM_COPY
              : ERROR_CODE_COPY[result.errorCode] ?? ERROR_CODE_COPY.INTERNAL,
          )
          if (typeof console !== 'undefined') {
            console.error(
              '[CreateMappingForm] createFieldMapping failed:',
              result,
            )
          }
          return
        }
        onSaveSuccess(result.tfmId)
      } catch (err) {
        setErrorCode('INTERNAL')
        setErrorMessage(ERROR_CODE_COPY.INTERNAL)
        if (typeof console !== 'undefined') {
          console.error('[CreateMappingForm] createFieldMapping threw:', err)
        }
      }
    })
  }

  const handleRefreshOnExistingTfm = () => {
    router.refresh()
    onCancel()
  }

  // ── Close routing — dirty → confirm dialog; clean → immediate ───
  const requestClose = () => {
    if (isDirty) {
      setConfirmDiscardOpen(true)
    } else {
      onCancel()
    }
  }

  const handleDialogKeepEditing = () => {
    setConfirmDiscardOpen(false)
  }

  const handleDialogDiscard = () => {
    setConfirmDiscardOpen(false)
    onCancel()
  }

  useImperativeHandle(
    ref,
    () => ({
      triggerSave: handleSave,
      requestClose,
    }),
    // intentionally re-create the handle on each render — closures
    // over `selectedIds`/`isSavePending`/`isDirty` need to be fresh.
  )

  // ── Derived UI flags ────────────────────────────────────────────
  const fieldsDisabled = isSavePending || confirmDiscardOpen
  const showCombinationRadios = selectedIds.length >= 2
  const isExistingTfmError =
    errorMessage === EXISTING_TFM_COPY && errorCode === 'VALIDATION'

  return (
    <div data-testid="create-mapping-form" className="flex flex-col gap-3">
      {errorMessage ? (
        <ErrorBanner
          message={errorMessage}
          showRefreshButton={isExistingTfmError}
          onRefresh={handleRefreshOnExistingTfm}
        />
      ) : null}

      <SourceFieldPicker
        availableSourceFields={availableSourceFields}
        selectedIds={selectedIds}
        onSelectedChange={handleSelectedChange}
        disabled={fieldsDisabled}
      />

      {showCombinationRadios ? (
        <CombinationRadios
          value={combinationType}
          onChange={setCombinationType}
          disabled={fieldsDisabled}
          selectedFields={selectedFields}
        />
      ) : null}

      <SamplePreview preview={samplePreview} />

      <DiscardChangesDialog
        targetFieldName={targetField.name}
        open={confirmDiscardOpen}
        onKeepEditing={handleDialogKeepEditing}
        onDiscard={handleDialogDiscard}
      />
    </div>
  )
})

// ── Error banner ─────────────────────────────────────────────────────────────

function ErrorBanner({
  message,
  showRefreshButton,
  onRefresh,
}: {
  message: string
  showRefreshButton: boolean
  onRefresh: () => void
}) {
  return (
    <div
      role="alert"
      data-testid="create-mapping-form-error"
      className={cn(
        'flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800',
      )}
    >
      <AlertCircle
        aria-hidden="true"
        className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-red-500"
      />
      <div className="flex flex-1 items-center justify-between gap-2">
        <span className="leading-snug">{message}</span>
        {showRefreshButton ? (
          <button
            type="button"
            onClick={onRefresh}
            data-testid="create-mapping-form-refresh"
            className={cn(
              'inline-flex h-6 items-center justify-center rounded border px-2 text-[11px] font-medium',
              'border-red-300 bg-white text-red-800 hover:bg-red-100',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40',
            )}
          >
            Refresh
          </button>
        ) : null}
      </div>
    </div>
  )
}

// ── Combination radios ───────────────────────────────────────────────────────

const COMBINATION_LABELS: Record<
  CreateFieldMappingCombinationType,
  string
> = {
  single: 'Use single source',
  concat_space: 'Concatenate with space',
  concat_comma: 'Concatenate with comma',
}

const CUSTOM_SQL_TOOLTIP =
  'Custom SQL combinations are managed in the Transform tab.'

function CombinationRadios({
  value,
  onChange,
  disabled,
  selectedFields,
}: {
  value: CreateFieldMappingCombinationType
  onChange: (next: CreateFieldMappingCombinationType) => void
  disabled: boolean
  selectedFields: SourceFieldWithState[]
}) {
  // Compute one-row example per combination from the actual selected
  // sources' first sample values. Falls back to canned literals when
  // any source has no samples.
  const example = (combination: 'concat_space' | 'concat_comma'): string => {
    const allHaveSamples = selectedFields.every((f) => f.sampleValues.length > 0)
    if (!allHaveSamples) {
      return combination === 'concat_space' ? 'Smith John' : 'Smith, John'
    }
    const firsts = selectedFields.map((f) => f.sampleValues[0]!)
    return firsts.join(combination === 'concat_space' ? ' ' : ', ')
  }

  return (
    <fieldset
      data-testid="create-mapping-form-combination"
      className="flex flex-col gap-1.5 rounded border border-slate-200 px-3 py-2"
      disabled={disabled}
    >
      <legend className="px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
        Combination
      </legend>
      <RadioRow
        name="combination"
        value="concat_space"
        checked={value === 'concat_space'}
        onChange={() => onChange('concat_space')}
        label={COMBINATION_LABELS.concat_space}
        example={`"${example('concat_space')}"`}
        disabled={disabled}
      />
      <RadioRow
        name="combination"
        value="concat_comma"
        checked={value === 'concat_comma'}
        onChange={() => onChange('concat_comma')}
        label={COMBINATION_LABELS.concat_comma}
        example={`"${example('concat_comma')}"`}
        disabled={disabled}
      />
      <RadioRow
        name="combination"
        value="custom_sql"
        checked={false}
        onChange={() => {}}
        label="Custom SQL"
        example="Managed in the Transform tab"
        disabled
        explicitlyBlocked
      />
    </fieldset>
  )
}

function RadioRow({
  name,
  value,
  checked,
  onChange,
  label,
  example,
  disabled,
  explicitlyBlocked = false,
}: {
  name: string
  value: string
  checked: boolean
  onChange: () => void
  label: string
  example: string
  disabled: boolean
  explicitlyBlocked?: boolean
}) {
  return (
    <label
      data-testid={`create-mapping-form-combination-${value}`}
      data-disabled={explicitlyBlocked ? 'true' : undefined}
      title={explicitlyBlocked ? CUSTOM_SQL_TOOLTIP : undefined}
      className={cn(
        'flex items-center gap-2 text-xs',
        explicitlyBlocked
          ? 'cursor-not-allowed text-slate-400'
          : 'cursor-pointer text-slate-700',
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        disabled={disabled || explicitlyBlocked}
        className="h-3.5 w-3.5 accent-blue-600"
      />
      <span className="font-medium">{label}</span>
      <span className="text-slate-400">—</span>
      <span className="font-mono">{example}</span>
    </label>
  )
}

// ── Sample preview ───────────────────────────────────────────────────────────

function SamplePreview({
  preview,
}: {
  preview: { preview: string[]; overflow: number }
}) {
  return (
    <div
      data-testid="create-mapping-form-preview"
      className="rounded border border-slate-200 px-3 py-2"
    >
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
        Sample preview
      </div>
      {preview.preview.length === 0 ? (
        <p
          data-testid="create-mapping-form-preview-empty"
          className="text-[11px] italic text-slate-400"
        >
          No sample values available
        </p>
      ) : (
        <ul
          data-testid="create-mapping-form-preview-list"
          className="space-y-0.5"
        >
          {preview.preview.map((row, idx) => (
            <li
              key={idx}
              data-testid="create-mapping-form-preview-row"
              className="truncate font-mono text-[11px] text-slate-700"
              title={row}
            >
              {row}
            </li>
          ))}
          {preview.overflow > 0 ? (
            <li
              data-testid="create-mapping-form-preview-overflow"
              className="text-[11px] italic text-slate-400"
            >
              + {preview.overflow} more
            </li>
          ) : null}
        </ul>
      )}
    </div>
  )
}

// ── Discard dialog ───────────────────────────────────────────────────────────

function DiscardChangesDialog({
  targetFieldName,
  open,
  onKeepEditing,
  onDiscard,
}: {
  targetFieldName: string
  open: boolean
  onKeepEditing: () => void
  onDiscard: () => void
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Esc / overlay-click both surface as "user wants to bail" —
        // collapse to the same path as the explicit Keep editing.
        // Per founder decision §1-OQ-1 this dismisses the dialog
        // ONLY (the parent does not bubble it to drawer-close).
        if (!next) onKeepEditing()
      }}
    >
      <AlertDialogContent data-testid="create-mapping-form-discard-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Discard changes?</AlertDialogTitle>
          <AlertDialogDescription>
            Your selected sources for{' '}
            <span className="font-mono text-gray-700">{targetFieldName}</span>{' '}
            will be lost. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            data-testid="create-mapping-form-discard-cancel"
            onClick={onKeepEditing}
          >
            Keep editing
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault()
              onDiscard()
            }}
            data-testid="create-mapping-form-discard-confirm"
            className="bg-red-600 hover:bg-red-700 focus:ring-red-500/40"
          >
            Discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
