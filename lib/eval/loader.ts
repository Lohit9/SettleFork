/**
 * Phase 1 PR 10.1 — dataset loader.
 *
 * Reads from `tests/eval/datasets/<name>/`:
 *   metadata.json
 *   schema.json
 *   examples/<task>/*.json
 *
 * Validates each example file has the required fields and returns a
 * `LoadedDataset` with examples grouped by task. Per-task scorers
 * (PR 10.2 / PR 10.3) own the inner `input`/`gold` shape validation.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import type {
  DatasetMetadata,
  DatasetSchema,
  EvalExample,
  EvalTask,
  LoadedDataset,
} from '@/lib/eval/types'

const REPO_ROOT = resolve(__dirname, '../..')
const DATASETS_DIR = resolve(REPO_ROOT, 'tests/eval/datasets')

const TASKS: readonly EvalTask[] = [
  'mapping',
  'transform',
  'nl-to-sql',
  'validation-rule',
  'mapping-suggestion',
  'quality-issues',
  'extracted-patterns',
  'fix-options',
] as const

/** Map from EvalTask → on-disk subdirectory name. They happen to match. */
function taskDir(task: EvalTask): string {
  return task
}

function readJson<T>(path: string): T {
  const raw = readFileSync(path, 'utf-8')
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    throw new Error(
      `[eval/loader] Failed to parse JSON at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function listJsonFilesInDir(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    // Directory missing → empty task list (legitimate).
    return []
  }
  const out: string[] = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isFile()) out.push(full)
  }
  return out.sort()
}

function validateExample(raw: unknown, path: string): EvalExample {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`[eval/loader] Example file ${path} is not an object`)
  }
  const r = raw as Record<string, unknown>
  for (const key of ['id', 'task', 'input', 'gold', 'metadata']) {
    if (!(key in r)) {
      throw new Error(`[eval/loader] Example ${path} missing required field "${key}"`)
    }
  }
  if (typeof r.id !== 'string') {
    throw new Error(`[eval/loader] Example ${path}: "id" must be a string`)
  }
  if (
    typeof r.task !== 'string' ||
    !TASKS.includes(r.task as EvalTask)
  ) {
    throw new Error(
      `[eval/loader] Example ${path}: "task" must be one of ${TASKS.join('|')}; got ${String(r.task)}`,
    )
  }
  if (typeof r.input !== 'object' || r.input === null) {
    throw new Error(`[eval/loader] Example ${path}: "input" must be an object`)
  }
  if (typeof r.gold !== 'object' || r.gold === null) {
    throw new Error(`[eval/loader] Example ${path}: "gold" must be an object`)
  }
  const meta = r.metadata as Record<string, unknown>
  if (
    typeof meta !== 'object' ||
    meta === null ||
    typeof meta.author !== 'string' ||
    typeof meta.difficulty !== 'string' ||
    !['easy', 'medium', 'hard'].includes(meta.difficulty)
  ) {
    throw new Error(
      `[eval/loader] Example ${path}: "metadata" must include author + difficulty(easy|medium|hard)`,
    )
  }
  return r as unknown as EvalExample
}

function validateMetadata(raw: unknown, path: string): DatasetMetadata {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`[eval/loader] metadata.json at ${path} is not an object`)
  }
  const r = raw as Record<string, unknown>
  for (const key of ['name', 'description', 'version', 'author', 'updatedAt']) {
    if (typeof r[key] !== 'string') {
      throw new Error(
        `[eval/loader] metadata.json at ${path} missing string field "${key}"`,
      )
    }
  }
  return r as unknown as DatasetMetadata
}

function validateSchema(raw: unknown, path: string): DatasetSchema {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`[eval/loader] schema.json at ${path} is not an object`)
  }
  const r = raw as Record<string, unknown>
  for (const side of ['source', 'target']) {
    const s = r[side]
    if (
      typeof s !== 'object' ||
      s === null ||
      !Array.isArray((s as { tables?: unknown }).tables)
    ) {
      throw new Error(
        `[eval/loader] schema.json at ${path}: "${side}.tables" must be an array`,
      )
    }
  }
  return r as unknown as DatasetSchema
}

/**
 * Load a dataset by directory name. Throws on any structural problem
 * (missing files, malformed JSON, missing required fields, unknown task).
 */
export function loadDataset(datasetName: string): LoadedDataset {
  const dir = resolve(DATASETS_DIR, datasetName)

  // Metadata + schema are required.
  const metadataPath = join(dir, 'metadata.json')
  const schemaPath = join(dir, 'schema.json')

  let metadata: DatasetMetadata
  let schema: DatasetSchema
  try {
    metadata = validateMetadata(readJson(metadataPath), metadataPath)
  } catch (err) {
    throw new Error(
      `[eval/loader] Could not load metadata for "${datasetName}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  try {
    schema = validateSchema(readJson(schemaPath), schemaPath)
  } catch (err) {
    throw new Error(
      `[eval/loader] Could not load schema for "${datasetName}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // Examples per task — directories are optional; missing → empty list.
  const examples: Record<EvalTask, EvalExample[]> = {
    mapping: [],
    transform: [],
    'nl-to-sql': [],
    'validation-rule': [],
    'mapping-suggestion': [],
    'quality-issues': [],
    'extracted-patterns': [],
    'fix-options': [],
  }
  const examplesRoot = join(dir, 'examples')

  for (const task of TASKS) {
    const taskRoot = join(examplesRoot, taskDir(task))
    const files = listJsonFilesInDir(taskRoot)
    for (const file of files) {
      const ex = validateExample(readJson(file), file)
      // Cross-check: example's declared task must match the directory.
      if (ex.task !== task) {
        throw new Error(
          `[eval/loader] Example ${file} declares task "${ex.task}" but lives under examples/${taskDir(task)}/`,
        )
      }
      examples[task].push(ex)
    }
  }

  return { name: datasetName, metadata, schema, examples }
}

/**
 * Discover all available dataset directory names. Returns sorted.
 * Skips dotfiles and any entry that's not a directory.
 */
export function listDatasets(): string[] {
  let entries: string[]
  try {
    entries = readdirSync(DATASETS_DIR)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of entries) {
    if (name.startsWith('.')) continue
    const full = join(DATASETS_DIR, name)
    try {
      const st = statSync(full)
      if (st.isDirectory()) out.push(name)
    } catch {
      // ignore unreadable entries
    }
  }
  return out.sort()
}
