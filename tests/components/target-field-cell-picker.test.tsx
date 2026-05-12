import { describe, it, expect, vi } from 'vitest'
import { useRef } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TargetFieldCellPicker } from '@/app/app/projects/[projectId]/mapping/redesign/components/TargetFieldCellPicker'
import type { TargetFieldRef } from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// TargetFieldCellPicker — flat-view target-cell editor unit tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pins the founder-locked behavior:
//   • Portal-rendered under document.body (escapes table overflow)
//   • Single-pick autoCommit semantics: clicking a row fires onCommit
//     immediately and closes on success
//   • Esc + click-outside cancel without committing
//   • The "current" target field renders disabled (a no-op pick should
//     just close the picker rather than fire a server action)
//   • Search filters the list by field name + target table name

function field(overrides: Partial<TargetFieldRef> = {}): TargetFieldRef {
  return {
    id: 'tf-default',
    name: 'col_default',
    dataType: 'VARCHAR(50)',
    isNullable: false,
    defaultValue: null,
    targetTable: { id: 'tt-default', name: 'DEFAULT_TABLE' },
    ordinalPosition: 1,
    isPrimaryKey: false,
    isForeignKey: false,
    fkReference: null,
    description: null,
    sampleValues: [],
    ...overrides,
  }
}

const FIELDS: TargetFieldRef[] = [
  field({ id: 'tf-1', name: 'customer_id', targetTable: { id: 'tt-1', name: 'Customers' } }),
  field({ id: 'tf-2', name: 'order_id', targetTable: { id: 'tt-2', name: 'Orders' } }),
  field({ id: 'tf-3', name: 'item_number', targetTable: { id: 'tt-2', name: 'Orders' } }),
]

interface HarnessProps {
  initialId: string | null
  onCommit: (id: string) => Promise<{ success: boolean }>
  onClose: () => void
  fields?: TargetFieldRef[]
}

function Harness({ initialId, onCommit, onClose, fields = FIELDS }: HarnessProps) {
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  return (
    <div>
      <button ref={anchorRef} type="button" data-testid="anchor">
        anchor
      </button>
      <TargetFieldCellPicker
        anchorRef={anchorRef}
        initialTargetFieldId={initialId}
        availableTargetFields={fields}
        onCommit={onCommit}
        onClose={onClose}
      />
    </div>
  )
}

function getRow(id: string): HTMLButtonElement {
  const el = document.querySelector(
    `[data-testid="target-field-cell-picker-field"][data-target-field-id="${id}"]`,
  )
  if (!(el instanceof HTMLButtonElement)) {
    throw new Error(`Row not found for id=${id}`)
  }
  return el
}

function commitSuccess(): Promise<{ success: boolean }> {
  return Promise.resolve({ success: true })
}

describe('TargetFieldCellPicker — portal + a11y', () => {
  it('portals under document.body', async () => {
    const { container } = render(
      <Harness initialId={null} onCommit={commitSuccess} onClose={vi.fn()} />,
    )
    const picker = await screen.findByTestId('target-field-cell-picker')
    expect(container.contains(picker)).toBe(false)
    expect(document.body.contains(picker)).toBe(true)
  })

  it('renders role=dialog with the locked aria-label', async () => {
    render(
      <Harness initialId={null} onCommit={commitSuccess} onClose={vi.fn()} />,
    )
    const picker = await screen.findByTestId('target-field-cell-picker')
    expect(picker.getAttribute('role')).toBe('dialog')
    expect(picker.getAttribute('aria-label')).toBe('Edit target field')
  })

  it('groups rows by target table', async () => {
    render(
      <Harness initialId={null} onCommit={commitSuccess} onClose={vi.fn()} />,
    )
    await screen.findByTestId('target-field-cell-picker')
    const groups = document.querySelectorAll(
      '[data-testid="target-field-cell-picker-group"]',
    )
    // Two unique target tables in the fixture (Customers, Orders).
    expect(groups.length).toBe(2)
  })
})

describe('TargetFieldCellPicker — autoCommit selection', () => {
  it('fires onCommit with the clicked field id and closes on success', async () => {
    const onCommit = vi.fn().mockResolvedValue({ success: true })
    const onClose = vi.fn()
    render(
      <Harness initialId={null} onCommit={onCommit} onClose={onClose} />,
    )
    await screen.findByTestId('target-field-cell-picker')

    fireEvent.click(getRow('tf-2'))

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith('tf-2'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('stays open when onCommit returns success=false (user can retry)', async () => {
    const onCommit = vi.fn().mockResolvedValue({ success: false })
    const onClose = vi.fn()
    render(
      <Harness initialId={null} onCommit={onCommit} onClose={onClose} />,
    )
    await screen.findByTestId('target-field-cell-picker')

    fireEvent.click(getRow('tf-2'))

    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('disables the current target field and re-selecting it just closes', async () => {
    const onCommit = vi.fn().mockResolvedValue({ success: true })
    const onClose = vi.fn()
    render(
      <Harness initialId="tf-1" onCommit={onCommit} onClose={onClose} />,
    )
    await screen.findByTestId('target-field-cell-picker')

    const currentRow = getRow('tf-1')
    expect(currentRow.disabled).toBe(true)
    expect(currentRow.getAttribute('data-is-current')).toBe('true')

    // Click the disabled current row — onCommit should NOT fire (disabled
    // browsers swallow the click). The button stays disabled regardless.
    fireEvent.click(currentRow)
    expect(onCommit).not.toHaveBeenCalled()
  })
})

describe('TargetFieldCellPicker — cancel paths', () => {
  it('Esc fires onClose without committing', async () => {
    const onCommit = vi.fn()
    const onClose = vi.fn()
    render(
      <Harness initialId={null} onCommit={onCommit} onClose={onClose} />,
    )
    await screen.findByTestId('target-field-cell-picker')

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onCommit).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('mousedown outside the picker AND outside the anchor cancels', async () => {
    const onClose = vi.fn()
    render(
      <Harness initialId={null} onCommit={commitSuccess} onClose={onClose} />,
    )
    await screen.findByTestId('target-field-cell-picker')

    fireEvent.mouseDown(document.body)

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
