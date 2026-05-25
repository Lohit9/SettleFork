/**
 * Build a directed dependency graph from tables and their FK relationships.
 *
 * Input: tables with fields (including is_foreign_key + fk_reference).
 * Output: nodes (tables) + edges (FK relationships) + topological load order.
 *
 * Used by the DependencyGraph component to render the visual migration map.
 */

import dagre from '@dagrejs/dagre'

// ─── Types ──────────────────────────────────────────────────────────

export interface GraphTable {
  id: string
  name: string
  datasetRole: 'source' | 'target'
  fieldCount: number
  mappedCount: number
  approvedCount: number
}

export interface GraphField {
  name: string
  tableId: string
  isForeignKey: boolean
  fkReference: string | null
}

export interface GraphNode {
  id: string
  name: string
  role: 'source' | 'target'
  fieldCount: number
  mappedCount: number
  approvedCount: number
  coveragePct: number
  status: 'done' | 'partial' | 'unmapped'
  /** Topological layer (0 = root, no FK deps) */
  layer: number
  x: number
  y: number
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  fkFieldName: string
  /** "source table depends on target table" */
  label: string
}

export interface DependencyGraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  loadOrder: string[]
  hasCycles: boolean
  cycleNodes: string[]
}

// ─── Cycle detection (Kahn's algorithm) ─────────────────────────────

function detectCycles(
  nodeIds: string[],
  edges: Array<{ from: string; to: string }>,
): { hasCycles: boolean; cycleNodes: string[]; topoOrder: string[] } {
  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()

  for (const id of nodeIds) {
    inDegree.set(id, 0)
    adj.set(id, [])
  }

  for (const { from, to } of edges) {
    if (!adj.has(from) || !inDegree.has(to)) continue
    adj.get(from)!.push(to)
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1)
  }

  const queue: string[] = []
  inDegree.forEach((deg, id) => {
    if (deg === 0) queue.push(id)
  })

  const topoOrder: string[] = []
  while (queue.length > 0) {
    const node = queue.shift()!
    topoOrder.push(node)
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1
      inDegree.set(neighbor, newDeg)
      if (newDeg === 0) queue.push(neighbor)
    }
  }

  const hasCycles = topoOrder.length < nodeIds.length
  const cycleNodes = hasCycles
    ? nodeIds.filter((id) => !topoOrder.includes(id))
    : []

  return { hasCycles, cycleNodes, topoOrder }
}

// ─── Build graph ────────────────────────────────────────────────────

export function buildDependencyGraph(
  tables: GraphTable[],
  fields: GraphField[],
): DependencyGraphData {
  const tableMap = new Map(tables.map((t) => [t.id, t]))
  const tablesByName = new Map(tables.map((t) => [t.name, t]))

  // Build edges from FK references
  const rawEdges: Array<{ from: string; to: string; fkField: string }> = []
  const seen = new Set<string>()

  for (const field of fields) {
    if (!field.isForeignKey || !field.fkReference) continue
    const sourceTable = tableMap.get(field.tableId)
    if (!sourceTable) continue

    // Parse FK reference: "TableName.FieldName" or "TableName(FieldName)" or "TableName"
    const refTableName = field.fkReference.split(/[.(]/)[0]
    const targetTable = tablesByName.get(refTableName)
    if (!targetTable) continue

    const edgeKey = `${field.tableId}->${targetTable.id}`
    if (seen.has(edgeKey)) continue
    seen.add(edgeKey)

    // Edge direction: this table DEPENDS ON the referenced table
    // So referenced table must load FIRST
    rawEdges.push({
      from: targetTable.id, // parent (load first)
      to: field.tableId, // child (load second)
      fkField: field.name,
    })
  }

  // Detect cycles + compute topo order
  const tableIds = tables.map((t) => t.id)
  const { hasCycles, cycleNodes, topoOrder } = detectCycles(
    tableIds,
    rawEdges.map((e) => ({ from: e.from, to: e.to })),
  )

  // Compute layers from topo order (BFS depth from roots)
  const layers = new Map<string, number>()
  const childAdj = new Map<string, string[]>()
  for (const id of tableIds) childAdj.set(id, [])
  for (const e of rawEdges) {
    childAdj.get(e.from)?.push(e.to)
  }

  // Roots = nodes with no incoming FK edges
  const hasIncoming = new Set(rawEdges.map((e) => e.to))
  const roots = tableIds.filter((id) => !hasIncoming.has(id))
  for (const r of roots) layers.set(r, 0)

  const bfsQueue = [...roots]
  while (bfsQueue.length > 0) {
    const id = bfsQueue.shift()!
    const myLayer = layers.get(id) ?? 0
    for (const child of childAdj.get(id) ?? []) {
      const existing = layers.get(child) ?? -1
      if (myLayer + 1 > existing) {
        layers.set(child, myLayer + 1)
        bfsQueue.push(child)
      }
    }
  }

  // Use dagre for actual x,y positioning
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', ranksep: 80, nodesep: 60 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const t of tables) {
    g.setNode(t.id, { width: 200, height: 80 })
  }
  for (const e of rawEdges) {
    g.setEdge(e.from, e.to)
  }

  dagre.layout(g)

  // Build output nodes
  const nodes: GraphNode[] = tables.map((t) => {
    const pos = g.node(t.id)
    const coveragePct =
      t.fieldCount > 0 ? Math.round((t.mappedCount / t.fieldCount) * 100) : 0
    const status: GraphNode['status'] =
      t.approvedCount === t.fieldCount && t.fieldCount > 0
        ? 'done'
        : t.mappedCount > 0
          ? 'partial'
          : 'unmapped'

    return {
      id: t.id,
      name: t.name,
      role: t.datasetRole,
      fieldCount: t.fieldCount,
      mappedCount: t.mappedCount,
      approvedCount: t.approvedCount,
      coveragePct,
      status,
      layer: layers.get(t.id) ?? 0,
      x: pos?.x ?? 0,
      y: pos?.y ?? 0,
    }
  })

  // Build output edges
  const edges: GraphEdge[] = rawEdges.map((e, i) => ({
    id: `edge-${i}`,
    source: e.from,
    target: e.to,
    fkFieldName: e.fkField,
    label: `FK: ${e.fkField}`,
  }))

  return {
    nodes,
    edges,
    loadOrder: topoOrder,
    hasCycles,
    cycleNodes,
  }
}
