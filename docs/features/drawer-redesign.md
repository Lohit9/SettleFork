# Drawer redesign — closure

## Status

Implementation complete and uncommitted on branch `feat/drawer-redesign`.
Bundles three passes:

1. **Initial drawer redesign** — visual + content refactor of the existing
   tabless redesign drawer. Stacked body sections (Sources / AI Reasoning /
   Transformation), inline edit pencil on Sources, contextual footer per row
   state, header compression to a 2-line summary, dropped tabs, dropped
   separate `DrawerSubheader`.
2. **First refinement pass** based on Heritage canary feedback —
   stacked-row header, collapsible sample values, AI reasoning aggregation
   (row-level + per-source), tightened body rhythm.
3. **Second refinement pass** based on follow-up canary review —
   body section reorder (AI Reasoning above Sources), Sample Values
   default-expanded, responsive 2-col grid for short sample values,
   header source/target font alignment (drop `font-semibold`).

Drawer width remains 480px. State machine, dirty-state mechanisms,
focus-restore wiring, and the 4-stage edit flow (view → edit → save → view)
are unchanged.

This doc lives separately to avoid conflicts with concurrent edits to
`docs/features/mapping-redesign.md` from the in-flight Phase 4-polish-1
workstream. Fold this content into the canonical doc on a follow-up after
both branches land on main.

---

## Refinement 1 — Stacked header (canary truncation fix)

**Problem.** The 2-line compressed header
(`[srcTable] srcField → [tgtTable] tgtField [✕]` on line 1, meta line 2)
was a Phase 4-polish-1 lock made before real Heritage data was on screen.
Canary on Heritage Core showed `status_name` truncating to `status_na...`
because 480px cannot fit source half + target half + arrow + close button at
realistic Heritage name lengths.

**Resolution.** Three-section vertical stack:

```
SOURCE                                     [✕]
[srcTable] srcField

TARGET
[tgtTable] tgtField

●  95.00%  Approved  ·  VARCHAR(50) → VARCHAR(50)
```

- Outer header: `border-b border-slate-200 bg-white px-5 py-4`. **Not
  sticky** — drawer body fits comfortably at 480px and scroll-to-Sources
  helpers (`+N sources` chip) work without pinning the header.
- Small-caps labels (`SOURCE`, `TARGET`) match the body section labels
  exactly: `text-xs uppercase tracking-wide text-slate-500`. Same primitive,
  same styling.
- Field name styling: `font-mono text-base font-semibold text-slate-900
  truncate` with `title` tooltip for overflow.
- TableBadge stays at `size='sm'`.
- Multi-source nuances:
  - Rule 2 (multi-source same table): single `[srcTable]` + comma-truncated
    field list, capped at 3 fields with `+N more` suffix.
  - Rule 3/4 (cross-table): dominant `[srcTable] srcField` plus
    `+N sources` chip aligned right of the source row. Chip is a button:
    `text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600`. Click
    scrolls body to Sources section via `scrollToSourcesSection` helper.
  - VA / Rule 5 / Rule 6: render `—` em-dash in `text-slate-400` where the
    source line would be — keeps the SOURCE/TARGET label rhythm consistent.
- Meta line: `[●] [confidence%] [status-word] · [srcType] → [tgtType]` in
  `text-xs text-slate-500 flex items-center gap-2`. Status word uses
  `wordClassName` from `DRAWER_STATUS_CONFIG` for color (e.g.
  `text-green-700` for approved).
- Suppressed entirely for Rule 6 (no status / no confidence / no source
  type).
- Rule 5 acknowledged: meta line shows status dot + "Acknowledged" only.
  No confidence, no types.

**Header height.** ~110-120px (was ~52-56px). Justified by canary screenshots
showing 60%+ empty space below Transformation on most rows.

## Refinement 2 — Sample values disclosure + per-source AI reasoning fold

**Problem.** Per-source line stuffed sample values inline as small-text
comma-separated content + an italic descriptive paragraph. Both felt
truncated and noisy.

**Italic paragraph data source — finding.** Investigation traced the italic
paragraph to `MappingSourceRef.aiReasoning` — the per-source AI reasoning
field on each `mapping_sources` row, distinct from the row-level
`MappingRowBase.aiReasoning` (which already powered the AI Reasoning
disclosure). Two separate sources were rendering AI reasoning in two
different surfaces at two different visual densities.

**Chosen resolution.** Fold into the existing AI Reasoning disclosure.
`AiReasoningDisclosure` now accepts both `rowAiReasoning: string | null` and
`perSourceReasonings: Array<{ sourceId; sourceTable; sourceField; reasoning
}>`. It renders the row-level reasoning first as a paragraph, then each
per-source reasoning as a labelled paragraph (`[srcTable].srcField` heading
+ body). Visibility gate widens to "render iff any reasoning is present"
(row-level OR per-source). The italic paragraph is removed from
`<SourceCard>`. A new `collectPerSourceReasonings(row)` helper extracts and
formats per-source reasoning at the row level.

**Sample values disclosure.** Replaces the inline truncation. Pattern:

```
▸ Sample values (8)        ← collapsed (default)
▾ Sample values (8)        ← expanded
   value_1
   value_2
   ...
```

- Disclosure label: `Sample values (N)` where N = full count including
  truncated tail.
- Collapsed by default. Reuses the existing `WhyToggle` pattern from AI
  Reasoning verbatim — same chevron (`▸` / `▾`), same `aria-expanded`,
  same transition.
- Expanded list: vertical, one value per line, `text-sm text-slate-700
  font-mono leading-relaxed pl-4 indent`.
- Empty / absent samples: section is omitted entirely.

## Refinement 3 — Visual rhythm tightening

- `<DrawerSection>` outer spacing reduced from `mb-6` to `mb-4`.
- Header SOURCE / TARGET small-caps labels and body SOURCES / AI REASONING /
  TRANSFORMATION small-caps labels share identical Tailwind: `text-xs
  uppercase tracking-wide text-slate-500`. They are the same visual
  primitive — only position (header vs body) carries the semantic
  distinction between "summary" and "detailed list".
- Header SOURCE (singular) vs body SOURCES (plural) reads cleanly because
  the header label sits above a single field summary while the body label
  sits above the per-source detail list with sample values, type
  compatibility, etc.

---

## Second refinement pass — body reorder + sample-values defaults

### Refinement 1 (second pass) — Body section reorder: AI Reasoning above Sources

For `needs_review` mappings the user's primary question is "is this right?"
— the AI reasoning answers that directly. Sources are evidence/details that
inform the answer. Reading reasoning first matches the user's task flow.
For `approved` rows the disclosure stays collapsed (Q11.B lock), so the
section is a single-line label at the top — net visual cost is negligible.

**Implementation.** `MappedBody` and `ValueAssignmentBody` swap the order
of `<AiReasoningDisclosure>` and the Sources `<DrawerSection>` in the JSX
flow. Visibility gates and conditional rendering rules unchanged. The
inline edit pencil's `aria-controls` and the `+N sources` chip's
`scrollToSourcesSection` helper are both testid-keyed and unaffected by
DOM order. `AcknowledgedBody` (Rule 5) and `UnmappedBody` (Rule 6) are
unaffected.

### Refinement 2 (second pass) — Sample Values default expanded

Canary screenshots showed ~50% empty vertical space below Transformation
on most rows. Defaulting the disclosure to expanded uses that space
productively and surfaces evidence the user would otherwise have to click
for. The disclosure remains user-toggleable; only the initial state
changes (`useState(true)` instead of `useState(false)`).

For rows with zero sample values, the section is omitted entirely
(unchanged behavior).

### Refinement 3 (second pass) — Sample Values responsive 2-col grid

For short string values (status codes, type codes, dates, IDs), a
single-column vertical list wastes horizontal space. The expanded panel
now applies an avg-length heuristic:

- Compute `avgLen = totalChars / sampleCount`.
- If `samples.length >= 2 && avgLen <= 20` → 2-column grid
  (`grid grid-cols-2 gap-x-3 gap-y-1 pl-4`).
- Otherwise → single-column flex (`flex flex-col gap-1 pl-4`).

The 20-char threshold is calibrated to the drawer's content width:
~430px usable, minus 16px `pl-4`, split into two ~204px tracks with 12px
gap → ~14 chars per cell with breathing room (`font-mono` glyph ~7.2px).
The threshold tolerates outliers via `truncate` + `title=` (full value on
hover).

The panel exposes `data-layout="grid" | "list"` for assertion. Each
sample renders as a `<div>` (block-level for both layouts). The earlier
`<ul>`/`<li>` semantic was dropped because `<ul>` with `display: grid`
mixes layout systems awkwardly — divs read consistently across both.

Edge cases:
- 1 sample value → always single-column (no grid benefit).
- Mixed lengths landing in the grid bucket → outliers wrap via
  `break-words` in the cell (or `truncate` with `title=` if width-bounded).

If canary surfaces a borderline case where the avg-length heuristic
produces a poor visual, the fallback is `max-length` instead of
`avg-length`, or tweaking the threshold to 15 / 25.

### Refinement 4 (second pass) — Header source/target font alignment

The header's source and target field rows previously rendered at
`font-mono text-base font-semibold text-slate-900`. The list view (4-
polish-1's surface) was being aligned in a parallel session: target
drops `font-semibold`, source upgrades from `text-slate-700` to
`text-slate-900`, both end at `font-mono font-normal text-slate-900`.

The drawer header now matches: all three field-row spans
(`HeaderSourceIdentity` Rule 2 multi-source, `HeaderSourceIdentity`
Rule 1/3/4 dominant, and `HeaderTargetIdentity` target) drop
`font-semibold` → `font-normal`. The SOURCE / TARGET small-caps
labels above the field rows continue to provide section emphasis;
bolding the field names themselves duplicated that signal.

A new test asserts that the source field row and target field row
share identical font/weight/color classes (`font-mono text-base
font-normal text-slate-900`), pinning the alignment so a future
refactor can't quietly diverge.

---

## Read-path contract change

`MappingRowBase` extends with two purely additive fields:

```ts
transformationDescription: string | null
transformationSqlPreview: string | null   // server-truncated to 300 chars
```

`_mappings-for-redesign-core.ts` translator populates both from the
existing `transformations` table join. Wrapper signatures in
`lib/actions/mappings-for-redesign.ts`, RPCs, and write paths are
untouched.

`TableBadge` extends with `size?: 'sm' | 'md'` (default `'md'`). All
existing call sites unchanged; only the new drawer header passes
`size='sm'`.

---

## Out of scope (explicitly preserved)

- All four dirty-state mechanisms — DiscardChangesDialog (4a-2), row-switch
  Undo (4a-4a), 'replace-ai' variant (4a-4b), EditInvalidationDialog
  (4b-1) — required zero rework. Confirmed clean by re-running the existing
  dirty-state test suites (all green).
- AI Suggest provenance laundering invariant (4a-4b) — untouched.
- Standalone Type Compatibility section — never created. Type compat renders
  inline beneath each per-source line as a single short sentence
  (`text-[11px] text-slate-500`).
- Standalone Confidence and Status sections — collapsed into the header
  meta line.
- Un-approve flow — deferred to Phase 4-polish-3 inline actions per the
  original lock.

---

## Smoke checklist for Heritage canary

- Stacked header: SOURCE row, TARGET row, meta line on third line.
- Header SOURCE / TARGET labels and body SOURCES / AI REASONING /
  TRANSFORMATION labels share identical small-caps styling.
- **AI Reasoning section appears above Sources** in the body (second
  refinement pass).
- Sample values: collapsible disclosure with count label, **defaults to
  expanded** (second refinement pass); user can still collapse.
- Sample values layout: **2-col grid for short values** (Heritage's
  STATUS_CODES, ACCT_TYPE_CD, DOB samples), **1-col for long values**
  (full names, addresses, descriptions). Single-sample edge case stays
  1-col (second refinement pass).
- **Source and target field rows render at identical weight**
  (`font-mono text-base font-normal text-slate-900`) — no more bold
  target field. Alignment matches the parallel list-view change
  (second refinement pass — Refinement 4).
- Status word visible next to status dot on meta line ("Approved" /
  "Needs review" / "Rejected" / "Acknowledged").
- Tightened body section spacing — three body sections feel less stacked.
- Long Heritage field names (`status_name`, `effective_start_date_ts`,
  `cif_master_account_status_code`) no longer truncate in the header.
- AI Reasoning disclosure shows both row-level reasoning and per-source
  labelled paragraphs when both exist; renders if either is present.
- Inline pencil on Sources section header opens edit mode for Rule 1/2/3/4
  + VA on `needs_review` and `approved`. Hidden for Rule 5, Rule 6, and
  `combinationType === 'custom_sql'`.
- Footer: `[Reject] [Approve]` on `needs_review`, `[Reject]` only on
  `approved`, `[Un-acknowledge]` solo on Rule 5, `[Suggest with AI]
  [Create mapping]` on Rule 6.
- Drawer width still 480px.
- Header is **not** sticky — confirm by scrolling a long Sources section
  with multiple expanded sample-value disclosures; header scrolls with
  body.

---

## Phase 4-polish-1 dependency

The drawer redesign consumes `classifyRowConfidence` and the threshold
constants from `lib/utils/confidence-format.ts`. That file is owned by
Phase 4-polish-1 and is read-only from this workstream. The drawer tests
were updated to expect the integer-rounded percent format
(`'88%'`, `'98%'`) introduced in Phase 4-polish-1 Refinement H.

If Phase 4-polish-1 lands first, this drawer branch consumes its constants
without conflict. If this branch lands first, the drawer's confidence
display falls back to whatever `formatConfidencePercent` returns at HEAD —
the visual contract is "render whatever the formatter produces", not
"assume integer rounding".
