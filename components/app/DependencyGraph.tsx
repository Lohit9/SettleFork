'use client'

/**
 * Visual dependency graph for migration table relationships.
 *
 * Shows tables as nodes, FK relationships as directed edges,
 * and migration readiness via color coding. Uses React Flow
 * with dagre layout for hierarchical DAG positioning.
 */

import { useCallback, useMemo } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  Handle,
  Position,
  MarkerType,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { DependencyGraphData, GraphNode } from '@/lib/utils/build-dependency-graph'

// ─── Status colors (matches Settle design system) ───────────────────

const STATUS_COLORS = {
  done: { bg: 'bg-emerald-50', border: 'border-emerald-300', dot: 'bg-emerald-500', text: 'text-emerald-700' },
  partial: { bg: 'bg-amber-50', border: 'border-amber-300', dot: 'bg-amber-500', text: 'text-amber-700' },
  unmapped: { bg: 'bg-slate-50', border: 'border-slate-200', dot: 'bg-slate-400', text: 'text-slate-500' },
} as const

const STATUS_MINIMAP_COLORS: Record<string, string> = {
  done: '#10b981',
  partial: '#f59e0b',
  unmapped: '#94a3b8',
}

// ─── Custom table node ──────────────────────────────────────────────

interface TableNodeData extends Record<string, unknown> {
  tableId: string
  name: string
  role: string
  fieldCount: number
  mappedCount: number
  approvedCount: number
  coveragePct: number
  status: 'done' | 'partial' | 'unmapped'
  layer: number
  onClick?: (tableId: string) => void
}

function TableNode({ data }: { data: TableNodeData }) {
  const colors = STATUS_COLORS[data.status]

  return (
    <div
      className={`rounded-lg border-2 ${colors.border} ${colors.bg} px-4 py-3 shadow-sm transition-shadow hover:shadow-md cursor-pointer min-w-[180px]`}
      onClick={() => data.onClick?.(data.tableId)}
    >
      <Handle type="target" position={Position.Top} className="!bg-slate-300 !w-2 !h-2" />

      {/* Table name + status dot */}
      <div className="flex items-center gap-2 mb-2">
        <span className={`w-2 h-2 rounded-full ${colors.dot} flex-shrink-0`} />
        <span className="font-semibold text-sm text-slate-800 truncate">
          {data.name}
        </span>
      </div>

      {/* Stats row */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-500">
          {data.fieldCount} fields
        </span>
        <span className={`font-mono font-medium ${colors.text}`}>
          {data.coveragePct}% mapped
        </span>
      </div>

      {/* Coverage bar */}
      <div className="mt-2 h-1.5 w-full rounded-full bg-slate-200 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            data.status === 'done'
              ? 'bg-emerald-500'
              : data.status === 'partial'
                ? 'bg-amber-400'
                : 'bg-slate-300'
          }`}
          style={{ width: `${data.coveragePct}%` }}
        />
      </div>

      {/* Approved count */}
      {data.approvedCount > 0 && (
        <div className="mt-1.5 text-xs text-slate-400">
          {data.approvedCount}/{data.fieldCount} approved
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="!bg-slate-300 !w-2 !h-2" />
    </div>
  )
}

const nodeTypes = { table: TableNode }

// ─── Main component ─────────────────────────────────────────────────

interface DependencyGraphProps {
  data: DependencyGraphData
  onTableClick?: (tableId: string) => void
}

export function DependencyGraph({ data, onTableClick }: DependencyGraphProps) {
  const nodes: Node[] = useMemo(
    () =>
      data.nodes.map((n) => ({
        id: n.id,
        type: 'table',
        position: { x: n.x - 100, y: n.y - 40 },
        data: {
          tableId: n.id,
          name: n.name,
          role: n.role,
          fieldCount: n.fieldCount,
          mappedCount: n.mappedCount,
          approvedCount: n.approvedCount,
          coveragePct: n.coveragePct,
          status: n.status,
          layer: n.layer,
          onClick: onTableClick,
        } satisfies TableNodeData,
      })),
    [data.nodes, onTableClick],
  )

  const edges: Edge[] = useMemo(
    () =>
      data.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.fkFieldName,
        type: 'smoothstep',
        animated: true,
        style: { stroke: '#94a3b8', strokeWidth: 1.5 },
        labelStyle: { fontSize: 10, fill: '#64748b' },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8', width: 16, height: 16 },
      })),
    [data.edges],
  )

  const minimapColor = useCallback(
    (node: Node) => {
      const d = node.data as Record<string, unknown>
      const status = (d?.status as string) || 'unmapped'
      return STATUS_MINIMAP_COLORS[status] || '#94a3b8'
    },
    [],
  )

  return (
    <div className="w-full h-full relative">
      {/* Header strip */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-4 bg-white/90 backdrop-blur-sm rounded-lg border border-slate-200 px-3 py-2 shadow-sm">
        <span className="text-xs font-medium text-slate-500 uppercase tracking-wider">
          Dependency Graph
        </span>
        <div className="flex items-center gap-3 text-xs text-slate-400">
          <span>{data.nodes.length} tables</span>
          <span>{data.edges.length} relationships</span>
          {data.hasCycles && (
            <span className="text-red-500 font-medium">
              ⚠ {data.cycleNodes.length} circular deps
            </span>
          )}
        </div>
      </div>

      {/* Load order strip */}
      {data.loadOrder.length > 0 && (
        <div className="absolute bottom-3 left-3 z-10 bg-white/90 backdrop-blur-sm rounded-lg border border-slate-200 px-3 py-2 shadow-sm max-w-[60%]">
          <div className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">
            Load Order
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            {data.loadOrder.map((id, i) => {
              const table = data.nodes.find((n) => n.id === id)
              if (!table) return null
              const colors = STATUS_COLORS[table.status]
              return (
                <span key={id} className="flex items-center gap-1">
                  {i > 0 && <span className="text-slate-300 text-xs">→</span>}
                  <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${colors.bg} ${colors.text} border ${colors.border}`}>
                    {table.name}
                  </span>
                </span>
              )
            })}
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="absolute top-3 right-3 z-10 bg-white/90 backdrop-blur-sm rounded-lg border border-slate-200 px-3 py-2 shadow-sm">
        <div className="flex items-center gap-3 text-xs">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            done
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-500" />
            in progress
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-slate-400" />
            unmapped
          </span>
        </div>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#e2e8f0" gap={20} size={1} />
        <Controls
          showInteractive={false}
          className="!bg-white !border-slate-200 !shadow-sm"
        />
        <MiniMap
          nodeColor={minimapColor}
          className="!bg-white !border-slate-200 !shadow-sm"
          maskColor="rgba(0,0,0,0.08)"
        />
      </ReactFlow>
    </div>
  )
}
