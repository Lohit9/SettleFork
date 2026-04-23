'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Mapping redesign — Phase 3 canonical home.
// ─────────────────────────────────────────────────────────────────────────────
//
// This directory is the single, canonical location for Phase 3 UI work on the
// Mapping page. All new components, hooks, and styles for the redesigned UI
// live here (or in colocated subfolders). The legacy UI at
// `../MappingContent.tsx` remains frozen except for the feature-flag dispatch
// gate at the top of its default export — see Gap 1 in
// `docs/features/mapping-redesign.md`.
//
// URL FILTER PARAM SCHEME (Phase 3, Gap 3)
//
//   The redesign uses a fresh, minimal filter param vocabulary:
//
//     ?target=<table-id>       — scope to a single target table
//     ?source=<table-id>       — scope to a single source table
//     ?status=<value>          — status filter (all | needs_review | approved | unmapped)
//     ?q=<search>              — free-text field-name search
//
//   Back-compat note (founder decision, out-of-band, 2026-04-21): the legacy
//   params `?fields=<ids>` and `?type=<mapping-type>` are NOT translated into
//   the new scheme. The redesign hard-resets filter state on first load; no
//   shim, no migration layer. Users who bookmarked legacy URLs will land on
//   the default (unfiltered) view. This keeps the new state machine clean and
//   avoids permanent coupling to the legacy filter vocabulary.
//
// CURRENT STATE (Gap 1)
//
//   Placeholder only. The real redesign ships in subsequent gaps (2–N). This
//   file's job is to prove the flag-gate plumbing works end-to-end: when
//   `projects.use_mapping_redesign = true`, this banner renders instead of
//   the legacy UI. When false (the default everywhere), the legacy UI renders
//   untouched.

import { PageHeader } from '@/components/app/PageHeader'
import { type ProjectInfo } from '@/components/app/ProjectInfoPopover'

interface Props {
  projectId: string
  projectName: string
  projectInfo?: ProjectInfo
}

export default function MappingRedesignContent({
  projectId,
  projectName,
  projectInfo,
}: Props) {
  return (
    <div className="flex flex-col h-full">
      <PageHeader
        projectName={projectName}
        title="Mapping"
        projectInfo={projectInfo}
      />
      <div className="flex-1 overflow-auto p-6">
        <div
          role="status"
          aria-live="polite"
          className="max-w-2xl mx-auto mt-8 rounded-lg border border-amber-300 bg-amber-50 px-6 py-5 text-amber-900"
          data-testid="mapping-redesign-placeholder"
        >
          <div className="text-base font-semibold">
            Mapping redesign — Phase 3 in progress
          </div>
          <p className="mt-2 text-sm text-amber-800">
            You are viewing the experimental redesigned Mapping UI. The full
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
        </div>
      </div>
    </div>
  )
}
