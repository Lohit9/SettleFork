// @vitest-environment node
//
// Loader unit tests — uses the `_fixture` dataset under
// tests/eval/datasets/_fixture/. The fixture is intentionally tiny
// (1 mapping + 1 validation example) so it loads in ms.

import { describe, it, expect } from 'vitest'
import { loadDataset, listDatasets } from '@/lib/eval/loader'

describe('loader — happy path', () => {
  it('loads the _fixture dataset', () => {
    const ds = loadDataset('_fixture')
    expect(ds.name).toBe('_fixture')
    expect(ds.metadata.name).toBe('_fixture')
    expect(ds.metadata.author).toMatch(/claude/i)
    expect(ds.schema.source.tables).toHaveLength(1)
    expect(ds.schema.target.tables).toHaveLength(1)
  })

  it('groups examples by task', () => {
    const ds = loadDataset('_fixture')
    // Post-PR-3.4b: mapping has 2 examples (001-fixture + 002-with-business-context).
    // PR 3.4cd commit 4: 4 new multi-agent fixtures (003-006). Total mapping fixtures = 6.
    expect(ds.examples.mapping).toHaveLength(6)
    expect(ds.examples['validation-rule']).toHaveLength(1)
    expect(ds.examples.transform).toHaveLength(0)
    expect(ds.examples['nl-to-sql']).toHaveLength(0)
  })

  it('preserves example structure (id, task, input, gold, metadata)', () => {
    const ds = loadDataset('_fixture')
    const ex = ds.examples.mapping[0]!
    expect(ex.id).toBe('_fixture/mapping/001-fixture')
    expect(ex.task).toBe('mapping')
    expect(ex.metadata.difficulty).toBe('easy')
    expect((ex.gold as { mappings: unknown[] }).mappings).toHaveLength(2)
  })
})

describe('loader — discovery', () => {
  it('listDatasets returns _fixture among results', () => {
    const datasets = listDatasets()
    expect(datasets).toContain('_fixture')
  })

  it('listDatasets returns sorted, dotfile-free results', () => {
    const datasets = listDatasets()
    const sorted = [...datasets].sort()
    expect(datasets).toEqual(sorted)
    expect(datasets.every((n) => !n.startsWith('.'))).toBe(true)
  })
})

describe('loader — error paths', () => {
  it('throws on missing dataset directory', () => {
    expect(() => loadDataset('does-not-exist-12345')).toThrow(
      /Could not load metadata/i,
    )
  })
})
