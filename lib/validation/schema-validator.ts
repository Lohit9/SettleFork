/**
 * Schema-level validation — checks that run across the entire migration
 * project, not on individual mappings.
 *
 * Uses the dependency graph to catch structural problems before any
 * field mapping begins.
 */

import {
  buildDependencyGraph,
  type GraphTable,
  type GraphField,
  type DependencyGraphData,
} from '@/lib/utils/build-dependency-graph'
import type { ValidationIssue, ValidationResult } from './mapping-validator'

// ─── Schema-level checks ────────────────────────────────────────────

function checkCircularDependencies(graph: DependencyGraphData): ValidationIssue[] {
  if (!graph.hasCycles) return []
  return graph.cycleNodes.map(nodeId => {
    const node = graph.nodes.find(n => n.id === nodeId)
    return {
      check: 'fk_circular_dependency' as const,
      severity: 'error' as const,
      message: `${node?.name ?? nodeId} is in a circular FK dependency`,
      detail: `This table and its FK partners reference each other. Migration requires staged loading: load with NULL FK columns first, then backfill FKs via UPDATE after all tables are populated.`,
      suggestion: `Split the migration into two passes: (1) load all rows with nullable FK columns set to NULL, (2) run UPDATE statements to populate the FK values.`,
    }
  })
}

function checkLoadOrderViolations(
  graph: DependencyGraphData,
  currentLoadOrder?: string[],
): ValidationIssue[] {
  if (!currentLoadOrder || currentLoadOrder.length === 0) return []

  const issues: ValidationIssue[] = []
  const correctOrder = graph.loadOrder
  const correctPositions = new Map(correctOrder.map((id, i) => [id, i]))

  for (let i = 0; i < currentLoadOrder.length; i++) {
    const tableId = currentLoadOrder[i]
    const correctPos = correctPositions.get(tableId)
    if (correctPos === undefined) continue

    // Check if any dependency comes AFTER this table in the current order
    for (const edge of graph.edges) {
      if (edge.target === tableId) {
        // edge.source must come before edge.target
        const parentPos = currentLoadOrder.indexOf(edge.source)
        if (parentPos > i) {
          const parentNode = graph.nodes.find(n => n.id === edge.source)
          const childNode = graph.nodes.find(n => n.id === tableId)
          issues.push({
            check: 'fk_load_order_violation',
            severity: 'error',
            message: `${childNode?.name} would load before ${parentNode?.name}, but depends on it via FK`,
            detail: `${childNode?.name} has a foreign key referencing ${parentNode?.name}. Loading ${childNode?.name} first will cause FK constraint violations.`,
            suggestion: `Reorder: load ${parentNode?.name} before ${childNode?.name}`,
          })
        }
      }
    }
  }
  return issues
}

function checkDisconnectedTables(graph: DependencyGraphData): ValidationIssue[] {
  const connected = new Set<string>()
  for (const edge of graph.edges) {
    connected.add(edge.source)
    connected.add(edge.target)
  }

  const disconnected = graph.nodes.filter(n => !connected.has(n.id))
  if (disconnected.length === 0) return []

  return [{
    check: 'fk_load_order_violation' as const,
    severity: 'info' as const,
    message: `${disconnected.length} table(s) have no FK relationships: ${disconnected.map(n => n.name).join(', ')}`,
    detail: `These tables can load in any order but may indicate missing FK annotations. Check if they should reference other tables.`,
  }]
}

function checkUnmappedRequiredFields(
  graph: DependencyGraphData,
): ValidationIssue[] {
  return graph.nodes
    .filter(n => n.status === 'unmapped' && n.fieldCount > 0)
    .map(n => ({
      check: 'unmapped_required_target' as const,
      severity: 'warning' as const,
      message: `${n.name} has ${n.fieldCount} fields with 0% mapping coverage`,
      detail: `This table has no field mappings yet. It will be empty after migration unless mappings are created.`,
      targetField: n.name,
    }))
}

// ─── Main schema validator ──────────────────────────────────────────

export function validateSchema(
  tables: GraphTable[],
  fields: GraphField[],
  currentLoadOrder?: string[],
): ValidationResult & { graph: DependencyGraphData } {
  const graph = buildDependencyGraph(tables, fields)

  const issues: ValidationIssue[] = [
    ...checkCircularDependencies(graph),
    ...checkLoadOrderViolations(graph, currentLoadOrder),
    ...checkDisconnectedTables(graph),
    ...checkUnmappedRequiredFields(graph),
  ]

  const counts = {
    errors: issues.filter(i => i.severity === 'error').length,
    warnings: issues.filter(i => i.severity === 'warning').length,
    info: issues.filter(i => i.severity === 'info').length,
  }

  return {
    valid: counts.errors === 0,
    issues,
    counts,
    graph,
  }
}
