'use client'

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

interface TransformResetWarningProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  action: 'remap' | 'delete' | 'regenerate'
  fieldName?: string
  hasTransform: boolean
  hasStagedData: boolean
  affectedCount?: number
  hasValueAssignment?: boolean
  createsMultiSource?: boolean
  conflictDetails?: Array<{ sourceFieldName: string | null; isValueAssignment: boolean }>
  isPKSourceChange?: boolean
  fkDependentCount?: number
  fkDependentNames?: string[]
}

export function TransformResetWarning({
  open,
  onOpenChange,
  onConfirm,
  action,
  fieldName,
  hasTransform,
  hasStagedData,
  affectedCount,
  hasValueAssignment = false,
  createsMultiSource = false,
  conflictDetails = [],
  isPKSourceChange = false,
  fkDependentCount = 0,
  fkDependentNames = [],
}: TransformResetWarningProps) {
  const isBulk = action === 'regenerate'

  // ── Title ──────────────────────────────────────────────────────────────────
  let title: string
  if (isBulk) {
    title = 'Regenerating will reset existing transforms'
  } else if (hasValueAssignment && createsMultiSource) {
    title = 'This will replace a value assignment and create a multi-source mapping'
  } else if (hasValueAssignment) {
    title = 'This will replace an existing value assignment'
  } else if (createsMultiSource) {
    title = 'This will create a many-to-one mapping'
  } else if (isPKSourceChange && fkDependentCount > 0) {
    title = 'Changing a primary key source will stale FK transforms'
  } else if (hasStagedData) {
    title = 'This field has staged data'
  } else {
    title = 'This field has an existing transform'
  }

  // ── Description ────────────────────────────────────────────────────────────
  let description: string
  if (isBulk) {
    description = `${affectedCount ?? 'Some'} field${(affectedCount ?? 0) !== 1 ? 's have' : ' has'} existing transforms. Regenerating mappings will clear all transforms and staged data. They will need to be regenerated for the new mappings.`
  } else if (action === 'delete') {
    description = `Deleting the mapping for "${fieldName}" will also remove its transform${hasStagedData ? ' and all staged data for this field' : ''}.`
  } else {
    const parts: string[] = []

    if (hasValueAssignment) {
      parts.push(`"${fieldName}" currently has a value assignment that will be replaced by this field mapping.`)
    }

    if (createsMultiSource) {
      const existingSource = conflictDetails.find((m) => !m.isValueAssignment)
      parts.push(
        `"${fieldName}" is already mapped from "${existingSource?.sourceFieldName ?? 'another source'}". Adding this mapping will create a many-to-one relationship. The existing transform will be reset since the inputs are changing.`
      )
    }

    if (hasTransform && !hasValueAssignment && !createsMultiSource) {
      parts.push(
        `Changing the mapping for "${fieldName}" will reset its transform${hasStagedData ? ' and remove its staged data' : ''}. A new transform will need to be generated for the new target field.`
      )
    }

    if (isPKSourceChange && fkDependentCount > 0) {
      const shownNames = fkDependentNames.slice(0, 5).join(', ')
      const overflow = fkDependentCount > 5 ? `, and ${fkDependentCount - 5} more` : ''
      parts.push(
        `This is a primary key field. Changing its source will mark ${fkDependentCount} FK dependent transform${fkDependentCount !== 1 ? 's' : ''} as stale: ${shownNames}${overflow}. You will need to re-cascade or regenerate those transforms afterward to maintain referential integrity.`
      )
    }

    description = parts.join('\n\n') || `Changing the mapping for "${fieldName}" will reset its transform. A new transform will need to be generated.`
  }

  // ── Confirm label ──────────────────────────────────────────────────────────
  const confirmLabel = isBulk
    ? 'Regenerate All'
    : action === 'delete'
    ? 'Delete Mapping'
    : hasValueAssignment && !createsMultiSource
    ? 'Replace Value Assignment'
    : createsMultiSource
    ? 'Add as Multi-Source'
    : 'Re-map and Reset'

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription className="whitespace-pre-line">{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-red-600 hover:bg-red-700 text-white"
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
