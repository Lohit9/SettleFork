'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Transform redesign — Phase 3 canonical home.
// ─────────────────────────────────────────────────────────────────────────────
//
// This directory is the single, canonical location for Phase 3 UI work on the
// Transform page. All new components, hooks, and styles for the redesigned UI
// live here (or in colocated subfolders). The legacy UI at
// `../TransformContent.tsx` remains frozen except for the feature-flag
// dispatch gate at the top of its default export — see Gap 1 in
// `docs/features/mapping-redesign.md`.
//
// URL FILTER PARAM SCHEME (Phase 3, Gap 3)
//
//   The redesign uses a fresh, minimal filter param vocabulary shared with
//   the Mapping page:
//
//     ?target=<table-id>       — scope to a single target table
//     ?source=<table-id>       — scope to a single source table
//     ?status=<value>          — status filter (applied | needs_transform | etc.)
//     ?q=<search>              — free-text field-name search
//
//   Back-compat note (founder decision, out-of-band, 2026-04-21): legacy
//   params (`?fields=`, `?type=`, etc.) are NOT translated. The redesign
//   hard-resets filter state on first load; no shim, no migration layer.
//
// CURRENT STATE (Gap 1)
//
//   Placeholder only. Real implementation ships in subsequent gaps.

import { PageHeader } from '@/components/app/PageHeader'
import { type ProjectInfo } from '@/components/app/ProjectInfoPopover'

interface Props {
  projectId: string
  projectName: string
  projectInfo?: ProjectInfo
  // Phase 4a-3: when true, render an additional note inside the
  // placeholder banner explaining that cross-table mapping transform
  // application is not yet supported. See
  // `docs/features/mapping-redesign.md` (Phase 4a-3 → Transform tab
  // transparency partial gap) for the full transparency stack.
  hasCrossTableMappings?: boolean
}

export default function TransformRedesignContent({
  projectId,
  projectName,
  projectInfo,
  hasCrossTableMappings = false,
}: Props) {
  return (
    <div className="flex flex-col h-full">
      <PageHeader
        projectName={projectName}
        title="Transform"
        projectInfo={projectInfo}
      />
      <div className="flex-1 overflow-auto p-6">
        <div
          role="status"
          aria-live="polite"
          className="max-w-2xl mx-auto mt-8 rounded-lg border border-amber-300 bg-amber-50 px-6 py-5 text-amber-900"
          data-testid="transform-redesign-placeholder"
        >
          <div className="text-base font-semibold">
            Transform redesign — Phase 3 in progress
          </div>
          <p className="mt-2 text-sm text-amber-800">
            You are viewing the experimental redesigned Transform UI. The full
            implementation is being landed incrementally under the
            <code className="mx-1 rounded bg-amber-100 px-1 py-0.5 text-xs">
              use_mapping_redesign
            </code>
            feature flag.
          </p>
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-amber-900/80">
            <dt className="font-medium">Project ID</dt>
            <dd className="font-mono">{projectId}</dd>
            <dt className="font-medium">Project name</dt>
            <dd>{projectName}</dd>
          </dl>
          {hasCrossTableMappings ? (
            // Phase 4a-3 — Transform tab transparency partial gap.
            // The redesign Transform UI is still a placeholder, so the
            // Block F Part B button-disabling layer is dormant. Surface
            // the cross-table apply limitation here so flag-on projects
            // with cross-table TFMs see the same notice they would see
            // in the legacy Transform tab.
            <p
              className="mt-3 text-xs text-slate-600"
              data-testid="transform-redesign-cross-table-note"
            >
              This project has cross-table mappings. Transform application
              for cross-table mappings ships in a future release.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
