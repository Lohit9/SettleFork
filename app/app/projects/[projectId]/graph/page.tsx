'use client'

/**
 * Dependency Graph page — visual map of table relationships and load order.
 *
 * Draft/demo version using mock data from a realistic ERP→CRM migration.
 * Production version will pull from Supabase datasets + fields tables.
 */

import dynamic from 'next/dynamic'
import { useMemo } from 'react'
import { buildDependencyGraph, type GraphTable, type GraphField } from '@/lib/utils/build-dependency-graph'

// React Flow requires browser APIs — skip SSR
const DependencyGraph = dynamic(
  () => import('@/components/app/DependencyGraph').then((m) => m.DependencyGraph),
  { ssr: false, loading: () => <div className="flex items-center justify-center h-full text-slate-400">Loading graph...</div> },
)

// ─── Mock data: Prosys → Rootstock ERP migration (RCB-scale) ────────

const MOCK_TABLES: GraphTable[] = [
  // Source: Prosys ERP
  { id: 't-customers', name: 'Customers', datasetRole: 'target', fieldCount: 24, mappedCount: 22, approvedCount: 20 },
  { id: 't-contacts', name: 'Contacts', datasetRole: 'target', fieldCount: 18, mappedCount: 15, approvedCount: 12 },
  { id: 't-addresses', name: 'Addresses', datasetRole: 'target', fieldCount: 12, mappedCount: 12, approvedCount: 12 },
  { id: 't-orders', name: 'Sales_Orders', datasetRole: 'target', fieldCount: 32, mappedCount: 28, approvedCount: 18 },
  { id: 't-order-lines', name: 'Order_Lines', datasetRole: 'target', fieldCount: 16, mappedCount: 14, approvedCount: 10 },
  { id: 't-products', name: 'Item_Master', datasetRole: 'target', fieldCount: 45, mappedCount: 38, approvedCount: 30 },
  { id: 't-bom', name: 'Bill_of_Materials', datasetRole: 'target', fieldCount: 22, mappedCount: 18, approvedCount: 8 },
  { id: 't-bom-lines', name: 'BOM_Lines', datasetRole: 'target', fieldCount: 14, mappedCount: 10, approvedCount: 4 },
  { id: 't-vendors', name: 'Vendors', datasetRole: 'target', fieldCount: 20, mappedCount: 16, approvedCount: 14 },
  { id: 't-purchase', name: 'Purchase_Orders', datasetRole: 'target', fieldCount: 28, mappedCount: 20, approvedCount: 12 },
  { id: 't-po-lines', name: 'PO_Lines', datasetRole: 'target', fieldCount: 15, mappedCount: 8, approvedCount: 4 },
  { id: 't-inventory', name: 'Inventory', datasetRole: 'target', fieldCount: 20, mappedCount: 0, approvedCount: 0 },
  { id: 't-commodity', name: 'Commodity_Codes', datasetRole: 'target', fieldCount: 6, mappedCount: 6, approvedCount: 6 },
  { id: 't-uom', name: 'Units_of_Measure', datasetRole: 'target', fieldCount: 4, mappedCount: 4, approvedCount: 4 },
  { id: 't-warehouses', name: 'Warehouses', datasetRole: 'target', fieldCount: 8, mappedCount: 6, approvedCount: 6 },
]

const MOCK_FIELDS: GraphField[] = [
  // Contacts → Customers
  { name: 'customer_id', tableId: 't-contacts', isForeignKey: true, fkReference: 'Customers.CustomerID' },
  // Addresses → Customers
  { name: 'customer_id', tableId: 't-addresses', isForeignKey: true, fkReference: 'Customers.CustomerID' },
  // Sales_Orders → Customers
  { name: 'customer_id', tableId: 't-orders', isForeignKey: true, fkReference: 'Customers.CustomerID' },
  // Order_Lines → Sales_Orders
  { name: 'order_id', tableId: 't-order-lines', isForeignKey: true, fkReference: 'Sales_Orders.OrderID' },
  // Order_Lines → Item_Master
  { name: 'item_id', tableId: 't-order-lines', isForeignKey: true, fkReference: 'Item_Master.ItemID' },
  // Bill_of_Materials → Item_Master
  { name: 'parent_item_id', tableId: 't-bom', isForeignKey: true, fkReference: 'Item_Master.ItemID' },
  // BOM_Lines → Bill_of_Materials
  { name: 'bom_id', tableId: 't-bom-lines', isForeignKey: true, fkReference: 'Bill_of_Materials.BomID' },
  // BOM_Lines → Item_Master (component)
  { name: 'component_item_id', tableId: 't-bom-lines', isForeignKey: true, fkReference: 'Item_Master.ItemID' },
  // Purchase_Orders → Vendors
  { name: 'vendor_id', tableId: 't-purchase', isForeignKey: true, fkReference: 'Vendors.VendorID' },
  // PO_Lines → Purchase_Orders
  { name: 'po_id', tableId: 't-po-lines', isForeignKey: true, fkReference: 'Purchase_Orders.PoID' },
  // PO_Lines → Item_Master
  { name: 'item_id', tableId: 't-po-lines', isForeignKey: true, fkReference: 'Item_Master.ItemID' },
  // Inventory → Item_Master
  { name: 'item_id', tableId: 't-inventory', isForeignKey: true, fkReference: 'Item_Master.ItemID' },
  // Inventory → Warehouses
  { name: 'warehouse_id', tableId: 't-inventory', isForeignKey: true, fkReference: 'Warehouses.WarehouseID' },
  // Item_Master → Commodity_Codes
  { name: 'commodity_code', tableId: 't-products', isForeignKey: true, fkReference: 'Commodity_Codes.Code' },
  // Item_Master → Units_of_Measure
  { name: 'uom_id', tableId: 't-products', isForeignKey: true, fkReference: 'Units_of_Measure.UomID' },
]

export default function GraphPage() {
  const graphData = useMemo(
    () => buildDependencyGraph(MOCK_TABLES, MOCK_FIELDS),
    [],
  )

  const handleTableClick = (tableId: string) => {
    const table = MOCK_TABLES.find((t) => t.id === tableId)
    if (table) {
      // Production: navigate to mapping page filtered to this table
      // For now: log to console
      console.log(`Navigate to mapping for: ${table.name}`)
    }
  }

  return (
    <div className="h-[calc(100vh-64px)] w-full">
      <DependencyGraph data={graphData} onTableClick={handleTableClick} />
    </div>
  )
}
