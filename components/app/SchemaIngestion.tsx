'use client'

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ChevronDown, ChevronRight, Upload } from '@/components/icons';
import { useRouter } from 'next/navigation';

interface SchemaIngestionProps {
  projectId: string;
}

const mockSourceSchema = {
  database: 'SALESFORCE_PROD',
  tables: [
    {
      name: 'Account',
      selected: true,
      fields: [
        { name: 'Id', type: 'VARCHAR(18)', nullable: false, pk: true, fk: false },
        { name: 'Name', type: 'VARCHAR(255)', nullable: false, pk: false, fk: false },
        { name: 'Type', type: 'VARCHAR(40)', nullable: true, pk: false, fk: false },
        { name: 'Industry', type: 'VARCHAR(40)', nullable: true, pk: false, fk: false },
        { name: 'AnnualRevenue', type: 'DECIMAL(18,2)', nullable: true, pk: false, fk: false },
      ]
    },
    {
      name: 'Contact',
      selected: true,
      fields: [
        { name: 'Id', type: 'VARCHAR(18)', nullable: false, pk: true, fk: false },
        { name: 'AccountId', type: 'VARCHAR(18)', nullable: true, pk: false, fk: true },
        { name: 'FirstName', type: 'VARCHAR(40)', nullable: true, pk: false, fk: false },
        { name: 'LastName', type: 'VARCHAR(80)', nullable: false, pk: false, fk: false },
        { name: 'Email', type: 'VARCHAR(80)', nullable: true, pk: false, fk: false },
      ]
    },
    {
      name: 'Opportunity',
      selected: false,
      fields: [
        { name: 'Id', type: 'VARCHAR(18)', nullable: false, pk: true, fk: false },
        { name: 'AccountId', type: 'VARCHAR(18)', nullable: true, pk: false, fk: true },
        { name: 'Name', type: 'VARCHAR(120)', nullable: false, pk: false, fk: false },
        { name: 'StageName', type: 'VARCHAR(40)', nullable: false, pk: false, fk: false },
        { name: 'Amount', type: 'DECIMAL(18,2)', nullable: true, pk: false, fk: false },
      ]
    }
  ]
};

const mockTargetSchema = {
  database: 'SAP_S4HANA',
  tables: [
    {
      name: 'CUSTOMER',
      selected: true,
      fields: [
        { name: 'CUSTOMER_ID', type: 'CHAR(10)', nullable: false, pk: true, fk: false },
        { name: 'CUSTOMER_NAME', type: 'VARCHAR(255)', nullable: false, pk: false, fk: false },
        { name: 'CUSTOMER_TYPE', type: 'VARCHAR(40)', nullable: true, pk: false, fk: false },
        { name: 'INDUSTRY_CODE', type: 'VARCHAR(40)', nullable: true, pk: false, fk: false },
        { name: 'ANNUAL_REVENUE', type: 'DECIMAL(18,2)', nullable: true, pk: false, fk: false },
      ]
    },
    {
      name: 'CONTACT_PERSON',
      selected: true,
      fields: [
        { name: 'CONTACT_ID', type: 'CHAR(10)', nullable: false, pk: true, fk: false },
        { name: 'CUSTOMER_ID', type: 'CHAR(10)', nullable: false, pk: false, fk: true },
        { name: 'FIRST_NAME', type: 'VARCHAR(40)', nullable: true, pk: false, fk: false },
        { name: 'LAST_NAME', type: 'VARCHAR(80)', nullable: false, pk: false, fk: false },
        { name: 'EMAIL_ADDRESS', type: 'VARCHAR(80)', nullable: true, pk: false, fk: false },
      ]
    },
    {
      name: 'SALES_ORDER',
      selected: false,
      fields: [
        { name: 'ORDER_ID', type: 'CHAR(10)', nullable: false, pk: true, fk: false },
        { name: 'CUSTOMER_ID', type: 'CHAR(10)', nullable: false, pk: false, fk: true },
        { name: 'ORDER_NAME', type: 'VARCHAR(120)', nullable: false, pk: false, fk: false },
        { name: 'ORDER_STATUS', type: 'VARCHAR(40)', nullable: false, pk: false, fk: false },
        { name: 'ORDER_AMOUNT', type: 'DECIMAL(18,2)', nullable: true, pk: false, fk: false },
      ]
    }
  ]
};

export function SchemaIngestion({ projectId }: SchemaIngestionProps) {
  const router = useRouter();
  const [sourceSchema, setSourceSchema] = useState(mockSourceSchema);
  const [targetSchema, setTargetSchema] = useState(mockTargetSchema);
  const [expandedSource, setExpandedSource] = useState<Set<string>>(new Set(['Account', 'Contact']));
  const [expandedTarget, setExpandedTarget] = useState<Set<string>>(new Set(['CUSTOMER', 'CONTACT_PERSON']));
  const [expandedSourceDb, setExpandedSourceDb] = useState(true);
  const [expandedTargetDb, setExpandedTargetDb] = useState(true);

  const toggleSource = (table: string) => {
    const newExpanded = new Set(expandedSource);
    if (newExpanded.has(table)) {
      newExpanded.delete(table);
    } else {
      newExpanded.add(table);
    }
    setExpandedSource(newExpanded);
  };

  const toggleTarget = (table: string) => {
    const newExpanded = new Set(expandedTarget);
    if (newExpanded.has(table)) {
      newExpanded.delete(table);
    } else {
      newExpanded.add(table);
    }
    setExpandedTarget(newExpanded);
  };

  const toggleTableSelection = (tableName: string, isSource: boolean) => {
    if (isSource) {
      setSourceSchema({
        ...sourceSchema,
        tables: sourceSchema.tables.map(t =>
          t.name === tableName ? { ...t, selected: !t.selected } : t
        )
      });
    } else {
      setTargetSchema({
        ...targetSchema,
        tables: targetSchema.tables.map(t =>
          t.name === tableName ? { ...t, selected: !t.selected } : t
        )
      });
    }
  };

  const selectAllTables = (isSource: boolean) => {
    if (isSource) {
      setSourceSchema({
        ...sourceSchema,
        tables: sourceSchema.tables.map(t => ({ ...t, selected: true }))
      });
    } else {
      setTargetSchema({
        ...targetSchema,
        tables: targetSchema.tables.map(t => ({ ...t, selected: true }))
      });
    }
  };

  const deselectAllTables = (isSource: boolean) => {
    if (isSource) {
      setSourceSchema({
        ...sourceSchema,
        tables: sourceSchema.tables.map(t => ({ ...t, selected: false }))
      });
    } else {
      setTargetSchema({
        ...targetSchema,
        tables: targetSchema.tables.map(t => ({ ...t, selected: false }))
      });
    }
  };

  const SchemaPanel = ({ 
    title, 
    schema, 
    expandedTables,
    expandedDb,
    onToggleDb,
    onToggleTable,
    onToggleSelection,
    onSelectAll,
    onDeselectAll,
    isSource,
  }: { 
    title: string; 
    schema: typeof mockSourceSchema; 
    expandedTables: Set<string>; 
    expandedDb: boolean;
    onToggleDb: () => void;
    onToggleTable: (table: string) => void;
    onToggleSelection: (table: string) => void;
    onSelectAll: () => void;
    onDeselectAll: () => void;
    isSource: boolean;
  }) => {
    const selectedCount = schema.tables.filter(t => t.selected).length;
    
    return (
      <div className="flex-1 bg-white rounded-xl border border-gray-200 flex flex-col">
        <div className="border-b border-gray-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
            <Button variant="outline" size="sm" className="gap-2">
              <Upload className="w-4 h-4" />
              Upload
            </Button>
          </div>
          <div className="flex items-center justify-between text-xs text-gray-500">
            <span>{selectedCount} of {schema.tables.length} tables selected</span>
            <div className="flex gap-2">
              <button
                onClick={onSelectAll}
                className="text-blue-600 hover:underline"
              >
                Select All
              </button>
              <span className="text-gray-300">|</span>
              <button
                onClick={onDeselectAll}
                className="text-gray-600 hover:underline"
              >
                Deselect All
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4">
          <div className="border border-gray-200 rounded-xl mb-2">
            <button
              onClick={onToggleDb}
              className="w-full flex items-center gap-2 p-3 hover:bg-gray-50 transition-colors"
            >
              {expandedDb ? (
                <ChevronDown className="w-4 h-4 text-gray-500" />
              ) : (
                <ChevronRight className="w-4 h-4 text-gray-500" />
              )}
              <span className="text-sm font-semibold text-blue-600">{schema.database}</span>
            </button>

            {expandedDb && (
              <div className="border-t border-gray-200 p-3 space-y-2">
                {schema.tables.map((table) => (
                  <div key={table.name} className="border border-gray-200 rounded-xl">
                    <div className="flex items-center gap-2 p-3 hover:bg-gray-50 transition-colors">
                      <Checkbox
                        checked={table.selected}
                        onCheckedChange={() => onToggleSelection(table.name)}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <button
                        onClick={() => onToggleTable(table.name)}
                        className="flex-1 flex items-center justify-between"
                      >
                        <div className="flex items-center gap-2">
                          {expandedTables.has(table.name) ? (
                            <ChevronDown className="w-4 h-4 text-gray-500" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-gray-500" />
                          )}
                          <span className="text-sm font-medium text-gray-900">{table.name}</span>
                        </div>
                        <span className="text-xs text-gray-500">{table.fields.length} fields</span>
                      </button>
                    </div>

                    {expandedTables.has(table.name) && (
                      <div className="border-t border-gray-200 p-3 bg-gray-50">
                        <table className="w-full">
                          <thead>
                            <tr className="text-xs text-gray-500 border-b border-gray-200">
                              <th className="text-left pb-2 font-medium">Field</th>
                              <th className="text-left pb-2 font-medium">Type</th>
                              <th className="text-center pb-2 font-medium">Nullable</th>
                              <th className="text-center pb-2 font-medium">Key</th>
                            </tr>
                          </thead>
                          <tbody>
                            {table.fields.map((field) => (
                              <tr key={field.name} className="text-xs border-b border-gray-200 last:border-0">
                                <td className="py-2 text-gray-900">{field.name}</td>
                                <td className="py-2 text-gray-600">{field.type}</td>
                                <td className="py-2 text-center">
                                  {field.nullable ? (
                                    <span className="text-gray-400">✓</span>
                                  ) : (
                                    <span className="text-gray-300">—</span>
                                  )}
                                </td>
                                <td className="py-2 text-center text-gray-600">
                                  {field.pk ? 'PK' : field.fk ? 'FK' : '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  const handleNext = () => {
    router.push(`/app/projects/${projectId}/mapping`);
  };

  return (
    <div className="flex-1 bg-gray-50 flex flex-col">
      <div className="flex-1 flex gap-6 overflow-hidden">
        <SchemaPanel
          title="Source Schema"
          schema={sourceSchema}
          expandedTables={expandedSource}
          expandedDb={expandedSourceDb}
          onToggleDb={() => setExpandedSourceDb(!expandedSourceDb)}
          onToggleTable={toggleSource}
          onToggleSelection={(table) => toggleTableSelection(table, true)}
          onSelectAll={() => selectAllTables(true)}
          onDeselectAll={() => deselectAllTables(true)}
          isSource={true}
        />

        <SchemaPanel
          title="Target Schema"
          schema={targetSchema}
          expandedTables={expandedTarget}
          expandedDb={expandedTargetDb}
          onToggleDb={() => setExpandedTargetDb(!expandedTargetDb)}
          onToggleTable={toggleTarget}
          onToggleSelection={(table) => toggleTableSelection(table, false)}
          onSelectAll={() => selectAllTables(false)}
          onDeselectAll={() => deselectAllTables(false)}
          isSource={false}
        />
      </div>

      <div className="border-t border-gray-200 bg-white p-6 flex justify-end">
        <Button
          onClick={handleNext}
          className="bg-blue-600 hover:bg-blue-700 text-white"
        >
          Generate Mappings
        </Button>
      </div>
    </div>
  );
}
