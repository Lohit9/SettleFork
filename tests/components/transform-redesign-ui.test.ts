import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Phase 3 — Transform redesign UI invariants (source-text pin).
 *
 * Block I covers the Transform redesign UI in two layers:
 *
 *   Layer 1: structural invariants — pinned here via source-text grep,
 *            same strategy as `transform-cross-table-enabled.test.ts`.
 *            The 3k-LOC component is far too expensive to mount in a
 *            unit test for negative invariants like "no source-led
 *            grouping" or "breadcrumb is target-first".
 *   Layer 2: dispatch invariants — pinned by `transform-dispatch.test.tsx`
 *            (Block H), which mounts the component at the empty-state
 *            and asserts the placeholder marker is gone.
 *
 * Glyph note (post-Phase-3 polish): the source-line "arrow" is rendered
 * in two distinct flavours. The sidebar uses the Lucide `CornerLeftUp`
 * icon (icon-rendered SVG, sized to the row's sub-text scale). The
 * editor breadcrumb uses the Unicode `←` (U+2190) character so it
 * stays visually consistent with the trailing `→` glyph in
 * `· View Mapping →`. Earlier drafts used the Unicode `↰` (U+21B0)
 * for both surfaces; tests below pin the post-polish split.
 *
 * The pins below cover:
 *   1. Target-led sidebar (Block D)            → grouping + alphabetical sort
 *   2. Two-line field row layout (Block D)     → target primary, CornerLeftUp + source secondary
 *   3. Multi-source truncation (Block D)       → +N badge at 3+ sources
 *   4. Breadcrumb invert (Block E)             → target ← source format (Unicode)
 *   5. Editor header invert (Block E)          → no legacy `→ target` form
 *   6. VA dismissal UI surface (Block F)       → testids + confirm dialog
 *   7. Dead-code cleanup (Block D)             → no f.isContributing filters
 *   8. URL param scheme (Block D)              → ?fields= keys on targetTableId
 */

const PATH = resolve(
  __dirname,
  '../../app/app/projects/[projectId]/transform/TransformContent.tsx',
)
const SRC = readFileSync(PATH, 'utf8')

// Strip comments so prose doesn't trip the negative greps. Block + line.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

// ─── 1. Target-led sidebar ─────────────────────────────────────────────────

describe('[transform redesign] sidebar is target-led (Block D)', () => {
  it('renders target-table groups, not dataset/table-mapping nesting', () => {
    // The redesigned sidebar collapses the legacy
    //   datasets[].tableMappings[].fields[]
    // tree to a single
    //   targetTableGroups[].rows[]
    // shape. Pin both the new walker and the absence of the old.
    expect(CODE).toMatch(/targetTableGroups/)
    expect(CODE).toMatch(/data\.targetTableGroups/)
  })

  it('TargetTableNode component drives the sidebar render', () => {
    // The new sidebar mounts a TargetTableNode per group and walks
    // `group.rows`. Pin the symbol so a regression that re-introduces
    // a DatasetNode/TableNode tree surfaces here. Auxiliary
    // `datasets.flatMap` calls for filter counts (e.g.
    // `allFieldsFlat` at the top of the component) are intentional
    // and stay — they aren't building the sidebar tree.
    expect(CODE).toMatch(/TargetTableNode/)
    expect(CODE).toMatch(/group\.rows/)
  })

  it('does NOT mount the legacy DatasetNode / TableNode wrappers in the sidebar tree', () => {
    // The legacy nesting was rendered by `DatasetNode` → `TableNode`
    // → `FieldRow`. Block D collapses that to TargetTableNode → row.
    // A regression that re-mounts the old components is loud here.
    expect(CODE).not.toMatch(/<DatasetNode\b/)
    expect(CODE).not.toMatch(/<TableNode\b/)
  })

  it('expand/collapse state keys on targetTableId, not table_mapping_id', () => {
    // The new state machine tracks expanded target tables. A
    // composite (sourceTable, targetTable) key would smuggle the
    // legacy nesting back in.
    expect(CODE).toMatch(/expandedTargetTables/)
    expect(CODE).not.toMatch(/expandedTableMappings/)
  })
})

// ─── 2. Field row layout ────────────────────────────────────────────────────

describe('[transform redesign] field row two-line layout (Block D)', () => {
  it('renders the source-line prefix as a Lucide CornerLeftUp icon', () => {
    // The locked layout puts the target field on line 1 and source(s)
    // on line 2 with a leading arrow icon. Post-polish the sidebar
    // uses the Lucide CornerLeftUp SVG (not a Unicode glyph). Pin
    // both the import and the rendered icon's testid so a regression
    // that swaps back to a Unicode arrow surfaces here.
    expect(SRC).toMatch(/import\s*\{[\s\S]*?CornerLeftUp[\s\S]*?\}\s*from\s*['"]@\/components\/icons['"]/)
    expect(SRC).toMatch(/<CornerLeftUp\b/)
    expect(SRC).toMatch(/data-testid="sidebar-source-arrow"/)
  })

  it('CornerLeftUp is sized to the sub-text scale (w-2.5 h-2.5)', () => {
    // The source-line is a `text-[10px]` row; the icon must shrink
    // to match. `w-2.5 h-2.5` is the locked sizing.
    expect(SRC).toMatch(/<CornerLeftUp[\s\S]{0,200}className="[^"]*\bw-2\.5\b[\s\S]{0,40}\bh-2\.5\b/)
  })

  it('CornerLeftUp is decorative — aria-hidden + flex-shrink-0', () => {
    // The semantic content is the source field name to its right.
    // The icon must not announce, must not compress under tight
    // truncation, and must inherit the sub-text colour.
    expect(SRC).toMatch(/<CornerLeftUp[\s\S]{0,200}aria-hidden="true"/)
    expect(SRC).toMatch(/<CornerLeftUp[\s\S]{0,200}flex-shrink-0/)
    expect(SRC).toMatch(/<CornerLeftUp[\s\S]{0,200}text-settle-slate-400/)
  })

  it('shows "No source mapped" sub-text for VA / unmapped target rows (no icon)', () => {
    // VA rows do NOT render the CornerLeftUp icon — the icon implies
    // "this comes from somewhere" and there is no source for VAs.
    // The text-only branch is pinned positively here; the negative
    // pin (no icon inside the VA branch) is structurally enforced
    // by the `isVA ? <span>No source mapped</span> : <CornerLeftUp /> + …`
    // shape in FieldRow.
    expect(SRC).toMatch(/No source mapped/)
  })
})

// ─── 3. Multi-source truncation ────────────────────────────────────────────

describe('[transform redesign] multi-source truncation (Block D)', () => {
  it('truncates 3+ sources with a +N badge', () => {
    // The locked rule:
    //   1 source  → A
    //   2 sources → A, B
    //   3+        → A, B, +N (with full list in title)
    // The leading arrow (CornerLeftUp icon in sidebar, Unicode `←`
    // in breadcrumb) is rendered separately from this list. The +N
    // construction lives in the sidebar row's source-list builder.
    // Pin the template literal so a regression that switches to
    // "and N more" copy or strips truncation entirely is loud.
    expect(SRC).toMatch(/\+\$\{[\s\S]*?-\s*2[\s\S]*?\}/)
  })

  it('full source list goes into a `title` attribute on overflow', () => {
    // The +N case leaks the full list via a tooltip
    // (`title={sourceList.truncated ? \`Sources: …\` : undefined}` and
    // a non-truncated mirror on the sidebar row).
    expect(SRC).toMatch(/`Sources:\s*\$\{sourceList\.full\}`/)
  })
})

// ─── 4. Editor breadcrumb invert ───────────────────────────────────────────

describe('[transform redesign] breadcrumb is target-led (Block E)', () => {
  it('breadcrumb leads with the target field, then ← source(s) (mapped TFM branch)', () => {
    // Pin the inverted ordering. The legacy breadcrumb was
    //   Transform · LOAN_TYPE · loan_type · View Mapping →
    // Phase 3 inverts to
    //   Transform · loan_type ← LOAN_TYPE · View Mapping →
    // — `targetFieldName` precedes the Unicode `←` (U+2190) and the
    // source list. The breadcrumb intentionally uses Unicode here
    // (rather than the Lucide icon used in the sidebar) so it
    // pairs visually with the trailing `→` in `· View Mapping →`.
    //
    // We anchor on the unique `sourceList.display` token (only the
    // mapped breadcrumb references it) and assert the ordering of
    // its preceding context: `targetFieldName` then `←`, terminated
    // by `· View Mapping →` shortly after. Index math beats a
    // greedy regex against a 3.4k-LOC file with many `targetFieldName`
    // call sites.
    const displayIdx = SRC.indexOf('sourceList.display')
    expect(displayIdx).toBeGreaterThan(-1)

    const before = SRC.slice(Math.max(0, displayIdx - 600), displayIdx)
    const after = SRC.slice(displayIdx, Math.min(SRC.length, displayIdx + 500))

    // The 600-char window before sourceList.display must contain
    // both the targetFieldName render and the `←` glyph, in that order.
    const targetIdx = before.lastIndexOf('targetFieldName')
    const arrowIdx = before.lastIndexOf('←')
    expect(targetIdx).toBeGreaterThan(-1)
    expect(arrowIdx).toBeGreaterThan(targetIdx)

    // The breadcrumb terminates with the View Mapping affordance.
    expect(after).toMatch(/View Mapping/)
  })

  it('breadcrumb does NOT use the legacy `↰` (U+21B0) glyph', () => {
    // Earlier drafts used the curl-up arrow on both surfaces. Polish
    // pass split it: sidebar = Lucide CornerLeftUp, breadcrumb =
    // Unicode `←`. A regression that re-introduces `↰` anywhere in
    // the rendered tree (vs. doc comments) would surface here. We
    // grep CODE (comments stripped) so the test note above doesn't
    // self-match.
    expect(CODE).not.toMatch(/↰/)
  })
})

// ─── 5. Editor header invert ───────────────────────────────────────────────

describe('[transform redesign] editor header is target-led (Block E)', () => {
  it('multi-source header has no legacy `source, contributor → target` form', () => {
    // The legacy header was `source, contributor → target`. Phase 3
    // collapsed the editor header into the inverted breadcrumb (the
    // `target ← source` row pinned above), so there is no separate
    // larger header in the post-redesign editor. The negative pin
    // here guards against a regression that re-introduces the legacy
    // `→ target` concatenation anywhere in the file.
    expect(SRC).not.toMatch(/contributingSourceFieldName[\s\S]{0,80}→\s*\$\{[^}]*targetFieldName/)
  })
})

// ─── 6. VA dismissal UI surface ────────────────────────────────────────────

describe('[transform redesign] VA dismissal UI surface (Block F)', () => {
  it('exposes the va-dismiss-link, confirm dialog, and reinstate button testids', () => {
    // These testids are the contract surface of the dismissal flow.
    // External tests (this suite included) and any future e2e harness
    // pin the flow on these markers.
    expect(SRC).toMatch(/data-testid="va-dismiss-link"/)
    expect(SRC).toMatch(/data-testid="va-dismiss-confirm-dialog"/)
    expect(SRC).toMatch(/data-testid="va-dismiss-confirm-button"/)
    expect(SRC).toMatch(/data-testid="va-dismissed-banner"/)
    expect(SRC).toMatch(/data-testid="va-reinstate-button"/)
  })

  it('Dismiss link is gated on isValueAssignment AND !vaDismissed AND no transformation', () => {
    // The link must be invisible for:
    //   - mapped TFMs (use needsTransform dismissal path instead)
    //   - already-dismissed VAs (show Reinstate banner)
    //   - VAs with a saved value (Clear button is the right affordance)
    expect(SRC).toMatch(
      /isValueAssignment[\s\S]{0,200}!\s*selectedContext\.field\.vaDismissed[\s\S]{0,200}transformation\s*===\s*null/,
    )
  })

  it('imports dismissValueAssignment + reinstateValueAssignment from transformations actions', () => {
    expect(SRC).toMatch(/dismissValueAssignment/)
    expect(SRC).toMatch(/reinstateValueAssignment/)
  })

  it('confirm dialog uses the locked copy "Mark this field as not needing a value?"', () => {
    // The exact phrasing was locked in the design block. Tests can
    // ride a hard string match here — copy changes are deliberate.
    expect(SRC).toMatch(/not needing a value/)
  })
})

// ─── 7. Dead-code cleanup ──────────────────────────────────────────────────

describe('[transform redesign] dead-code cleanup (Block D)', () => {
  it('does NOT filter on f.isContributing in any sidebar derivation', () => {
    // Finding 8 from the investigation: the legacy multi-source
    // representation used a per-FM `is_contributing` flag. The new
    // schema uses `mapping_sources.ordinal`. Filtering on
    // `f.isContributing` is dead code in the redesigned sidebar.
    expect(CODE).not.toMatch(/f\.isContributing/)
  })
})

// ─── 8. URL param scheme ───────────────────────────────────────────────────

describe('[transform redesign] URL param scheme keys on target table (Block D)', () => {
  it('selectedTableIds derives from targetTableId, not (sourceTable, targetTable) tuples', () => {
    // The `?fields=…` URL serialisation didn't change shape (it still
    // carries field-level ids), but the in-memory tables-filter set
    // moved from table_mapping ids to target-table ids. Pin the
    // identifier so a refactor that re-introduces `sourceTableId` /
    // `tableMappingId` keys in the filter selection state is loud.
    expect(CODE).toMatch(/selectedTableIds/)
    expect(CODE).toMatch(/targetTableId/)
  })
})
