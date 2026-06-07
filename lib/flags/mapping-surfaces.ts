// Per-surface feature flags for the mapping-redesign mock→real migration.
//
// The "Claude design" shipped two hardcoded design surfaces — MockSpecTable
// (Map & Transform) and MockDataPreview (Data Preview) — that render fixed
// sample data and persist nothing. These flags let each surface swap over to
// live database reads independently: wire one, verify it, move on, rather than
// flipping everything at once.
//
// Default OFF = the mock keeps rendering, so behaviour is unchanged until a
// surface's real data path is wired and verified. Exact '1' match mirrors the
// AI_PHASE_* convention (CLAUDE.md §4.5.1): any other value reads as OFF. The
// NEXT_PUBLIC_ prefix is required — both consumers are client components.

export const USE_REAL_SPEC_TABLE =
  process.env.NEXT_PUBLIC_USE_REAL_SPEC_TABLE === '1'

export const USE_REAL_DATA_PREVIEW =
  process.env.NEXT_PUBLIC_USE_REAL_DATA_PREVIEW === '1'
