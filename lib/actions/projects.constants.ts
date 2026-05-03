// Module-level constants for project mutation actions.
// Lives outside `'use server'` because Next.js only permits async function
// exports from server-action files. Imported by lib/actions/projects.ts
// (used in Zod schemas) and tests/actions/projects-validation.test.ts
// (verified against runtime values).

export const PROJECT_NAME_MAX_LENGTH = 120
export const DATASET_LABEL_MAX_LENGTH = 80
