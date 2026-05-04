// @vitest-environment node
//
// Source-level invariant tests for the Mapping page virtualization
// (PR feat/mapping-virtualization). Pin the structural commitment;
// runtime visual behavior is covered by manual UX verification per
// docs/known-issues.md PR safety Rule 1 (browser-required for any
// optimistic-update + animation surface).
//
// Invariants:
//   VIRT1.  package.json declares @tanstack/react-virtual as a
//           runtime dependency.
//   VIRT2.  TargetTableGroup.tsx imports useWindowVirtualizer from
//           @tanstack/react-virtual.
//   VIRT3.  TargetTableGroup carries a row-count threshold constant
//           (VIRTUALIZATION_THRESHOLD or similar) AND uses it in a
//           conditional gating the virtualized vs non-virtualized
//           render paths.
//   VIRT4.  FieldMappingRow is wrapped in React.forwardRef. The
//           outer row div accepts the forwarded ref AND forwards
//           data-index for measureElement keying when the row is
//           rendered inside a virtualized list.
//   VIRT5.  MappingContent owns lifted per-row UI state — both
//           expandedRowIds: Map<string, boolean> AND pickerOpenRowId:
//           string | null — and threads them into <TargetTableGroup>.
//           FieldMappingRow's interface declares the matching
//           lifted-state props (negative pin via prop names; doesn't
//           require local useState removal because backward-compat
//           fallback to local state is preserved for legacy callers).
//   VIRT6.  MappingContent contains TWO cleanup useEffects on
//           [data.rows] dependency that close the popover/picker
//           when their anchor row dissolves. Both must be present —
//           asymmetric coverage between RejectConfirmPopover and
//           InlineSourcePicker would create bug surface (Issue 2 was
//           framed as a class of cases, not a single bug).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../..')
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8')

const PACKAGE_JSON = read('package.json')
const TARGET_TABLE_GROUP = read(
  'app/app/projects/[projectId]/mapping/redesign/components/TargetTableGroup.tsx',
)
const FIELD_MAPPING_ROW = read(
  'app/app/projects/[projectId]/mapping/redesign/components/FieldMappingRow.tsx',
)
const MAPPING_CONTENT = read(
  'app/app/projects/[projectId]/mapping/redesign/MappingContent.tsx',
)

describe('[mapping-virtualization] VIRT1-VIRT6 source-level invariants', () => {
  it('VIRT1: package.json declares @tanstack/react-virtual as a dependency', () => {
    expect(PACKAGE_JSON).toMatch(
      /["']@tanstack\/react-virtual["']\s*:\s*["'][^"']+["']/,
    )
  })

  it('VIRT2: TargetTableGroup.tsx imports useWindowVirtualizer from @tanstack/react-virtual', () => {
    expect(TARGET_TABLE_GROUP).toMatch(
      /import\s+\{[^}]*\buseWindowVirtualizer\b[^}]*\}\s+from\s+['"]@tanstack\/react-virtual['"]/,
    )
  })

  it('VIRT3: TargetTableGroup carries a row-count threshold constant AND uses it in a conditional gating the virtualizer path', () => {
    // The constant declaration. Match a `const FOO = <number>` where
    // the name suggests virtualization threshold.
    expect(TARGET_TABLE_GROUP).toMatch(
      /const\s+VIRTUALIZATION_THRESHOLD\s*=\s*\d+/,
    )
    // The constant is referenced in a conditional comparing rows.length.
    expect(TARGET_TABLE_GROUP).toMatch(
      /rows\.length\s*[<>=!]+\s*VIRTUALIZATION_THRESHOLD/,
    )
  })

  it('VIRT4: FieldMappingRow is wrapped in forwardRef, attaches the ref to the outer div, and forwards data-index for measureElement keying', () => {
    // forwardRef import + use.
    expect(FIELD_MAPPING_ROW).toMatch(/\bforwardRef\b/)
    // The outer div consumes the ref.
    expect(FIELD_MAPPING_ROW).toMatch(/<div\b[\s\S]{0,200}?\bref=\{ref\}/)
    // data-index attribute (virtualizer keying hook).
    expect(FIELD_MAPPING_ROW).toMatch(/data-index=\{dataIndex\}/)
  })

  it('VIRT5: MappingContent owns lifted state (expandedRowIds + pickerOpenRowId), threads it into <TargetTableGroup>, and FieldMappingRow declares the matching props', () => {
    // MappingContent declares both state slots.
    expect(MAPPING_CONTENT).toMatch(
      /const\s+\[expandedRowIds,\s*setExpandedRowIds\]\s*=\s*useState<\s*Map<string,\s*boolean>/,
    )
    expect(MAPPING_CONTENT).toMatch(
      /const\s+\[pickerOpenRowId,\s*setPickerOpenRowId\]\s*=\s*useState<\s*string\s*\|\s*null>/,
    )
    // Threaded into <TargetTableGroup> JSX.
    expect(MAPPING_CONTENT).toMatch(/expandedRowIds=\{expandedRowIds\}/)
    expect(MAPPING_CONTENT).toMatch(/pickerOpenRowId=\{pickerOpenRowId\}/)
    // FieldMappingRow's interface declares the matching props.
    expect(FIELD_MAPPING_ROW).toMatch(/\bisExpanded\?\s*:\s*boolean\b/)
    expect(FIELD_MAPPING_ROW).toMatch(
      /\bonExpandedChange\?\s*:\s*\(next:\s*boolean\)\s*=>\s*void/,
    )
    expect(FIELD_MAPPING_ROW).toMatch(/\bisPickerOpen\?\s*:\s*boolean\b/)
    expect(FIELD_MAPPING_ROW).toMatch(
      /\bonPickerOpenChange\?\s*:\s*\(next:\s*boolean\)\s*=>\s*void/,
    )
  })

  it('VIRT6: MappingContent contains TWO cleanup useEffects on [data.rows] — one closes pickerOpenRowId, one closes rejectAnchor (Issue 2 symmetric coverage)', () => {
    // pickerOpenRowId cleanup: useEffect with [data.rows, pickerOpenRowId]
    // deps that calls setPickerOpenRowId(null) gated on data.rows
    // not finding the rowId.
    expect(MAPPING_CONTENT).toMatch(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]*?setPickerOpenRowId\(null\)[\s\S]*?\},\s*\[data\.rows,\s*pickerOpenRowId\]\s*\)/,
    )
    // rejectAnchor cleanup: same shape but for setRejectAnchor.
    expect(MAPPING_CONTENT).toMatch(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]*?setRejectAnchor\(null\)[\s\S]*?\},\s*\[data\.rows,\s*rejectAnchor\]\s*\)/,
    )
  })
})
