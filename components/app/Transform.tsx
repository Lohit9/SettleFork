'use client'

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ArrowRight, RefreshCw, Play, ChevronDown, ChevronRight, AlertCircle } from '@/components/icons';
import { useRouter } from 'next/navigation';

interface TransformProps {
  projectId: string;
}

interface FieldTransform {
  sourceField: string;
  targetField: string;
  hasTransform: boolean;
  prompt?: string;
  sql?: string;
  tested?: boolean;
}

interface TableTransforms {
  sourceTable: string;
  targetTable: string;
  fields: FieldTransform[];
}

const mockTransforms: TableTransforms[] = [
  {
    sourceTable: 'Account',
    targetTable: 'CUSTOMER',
    fields: [
      {
        sourceField: 'Id',
        targetField: 'CUSTOMER_ID',
        hasTransform: true,
        prompt: 'Convert 18-character Salesforce ID to 10-character format using prefix CUST and sequential numbering',
        sql: `CONCAT('CUST', LPAD(ROW_NUMBER() OVER (ORDER BY Id), 6, '0'))`,
        tested: true,
      },
      {
        sourceField: 'Name',
        targetField: 'CUSTOMER_NAME',
        hasTransform: false,
      },
      {
        sourceField: 'Type',
        targetField: 'CUSTOMER_TYPE',
        hasTransform: true,
        prompt: 'Convert account type values to uppercase and map standard values',
        sql: `CASE 
  WHEN Type = 'Prospect' THEN 'PROSPECT'
  WHEN Type = 'Customer' THEN 'CUSTOMER'
  WHEN Type = 'Partner' THEN 'PARTNER'
  ELSE 'OTHER'
END`,
        tested: true,
      },
      {
        sourceField: 'Industry',
        targetField: 'INDUSTRY_CODE',
        hasTransform: true,
        prompt: 'Map industry names to SAP industry codes',
        sql: `CASE 
  WHEN Industry = 'Technology' THEN 'TECH'
  WHEN Industry = 'Manufacturing' THEN 'MANU'
  WHEN Industry = 'Healthcare' THEN 'HLTH'
  WHEN Industry = 'Finance' THEN 'FINC'
  ELSE 'OTHR'
END`,
        tested: false,
      },
      {
        sourceField: 'AnnualRevenue',
        targetField: 'ANNUAL_REVENUE',
        hasTransform: false,
      },
    ]
  },
  {
    sourceTable: 'Contact',
    targetTable: 'CONTACT_PERSON',
    fields: [
      {
        sourceField: 'Id',
        targetField: 'CONTACT_ID',
        hasTransform: true,
        prompt: 'Convert 18-character Salesforce ID to 10-character format using prefix CONT',
        sql: `CONCAT('CONT', LPAD(ROW_NUMBER() OVER (ORDER BY Id), 6, '0'))`,
        tested: true,
      },
      {
        sourceField: 'AccountId',
        targetField: 'CUSTOMER_ID',
        hasTransform: true,
        prompt: 'Convert related Account ID to CUSTOMER_ID format',
        sql: `CONCAT('CUST', LPAD(ROW_NUMBER() OVER (PARTITION BY AccountId ORDER BY Id), 6, '0'))`,
        tested: false,
      },
      {
        sourceField: 'FirstName',
        targetField: 'FIRST_NAME',
        hasTransform: false,
      },
      {
        sourceField: 'LastName',
        targetField: 'LAST_NAME',
        hasTransform: false,
      },
      {
        sourceField: 'Email',
        targetField: 'EMAIL_ADDRESS',
        hasTransform: false,
      },
    ]
  }
];

export function Transform({ projectId }: TransformProps) {
  const router = useRouter();
  const [transforms, setTransforms] = useState(mockTransforms);
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set(['Account']));
  const [expandedDb, setExpandedDb] = useState(true);
  const [selectedField, setSelectedField] = useState<{
    tableIndex: number;
    fieldIndex: number;
  } | null>({ tableIndex: 0, fieldIndex: 2 });
  const [showSQL, setShowSQL] = useState(true);
  const [prompt, setPrompt] = useState('');

  const toggleTable = (tableName: string) => {
    const newExpanded = new Set(expandedTables);
    if (newExpanded.has(tableName)) {
      newExpanded.delete(tableName);
    } else {
      newExpanded.add(tableName);
    }
    setExpandedTables(newExpanded);
  };

  const selectField = (tableIndex: number, fieldIndex: number) => {
    setSelectedField({ tableIndex, fieldIndex });
    const field = transforms[tableIndex].fields[fieldIndex];
    setPrompt(field.prompt || '');
  };

  const selectedTransform = selectedField 
    ? transforms[selectedField.tableIndex].fields[selectedField.fieldIndex]
    : null;

  const selectedTableName = selectedField
    ? transforms[selectedField.tableIndex].sourceTable
    : null;

  const testData = [
    { before: 'Prospect', after: 'PROSPECT' },
    { before: 'Customer', after: 'CUSTOMER' },
    { before: 'Partner', after: 'PARTNER' },
  ];

  const fieldsNeedingTransform = transforms.reduce((count, table) => 
    count + table.fields.filter(f => f.hasTransform).length, 0
  );

  const handleNext = () => {
    router.push(`/app/projects/${projectId}/validate`);
  };

  return (
    <div className="flex-1 bg-gray-50 flex">
      <div className="w-80 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-4 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-900 mb-2">Select Fields to Transform</h2>
          <p className="text-xs text-gray-500">
            {fieldsNeedingTransform} field{fieldsNeedingTransform !== 1 ? 's' : ''} require transformation
          </p>
        </div>

        <div className="flex-1 overflow-auto p-4">
          <div className="border border-gray-200 rounded-xl">
            <button
              onClick={() => setExpandedDb(!expandedDb)}
              className="w-full flex items-center gap-2 p-3 hover:bg-gray-50 transition-colors"
            >
              {expandedDb ? (
                <ChevronDown className="w-4 h-4 text-gray-500" />
              ) : (
                <ChevronRight className="w-4 h-4 text-gray-500" />
              )}
              <span className="text-sm font-semibold text-blue-600">SALESFORCE_PROD</span>
            </button>

            {expandedDb && (
              <div className="border-t border-gray-200 p-3 space-y-2">
                {transforms.map((table, tableIndex) => (
                  <div key={table.sourceTable} className="border border-gray-200 rounded-xl">
                    <button
                      onClick={() => toggleTable(table.sourceTable)}
                      className="w-full flex items-center justify-between p-3 hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        {expandedTables.has(table.sourceTable) ? (
                          <ChevronDown className="w-4 h-4 text-gray-500" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-gray-500" />
                        )}
                        <span className="text-sm font-medium text-gray-900">
                          {table.sourceTable}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <ArrowRight className="w-3 h-3 text-gray-400" />
                        <span className="text-xs text-gray-600">{table.targetTable}</span>
                      </div>
                    </button>

                    {expandedTables.has(table.sourceTable) && (
                      <div className="border-t border-gray-200 bg-gray-50">
                        {table.fields.map((field, fieldIndex) => {
                          const isSelected = selectedField?.tableIndex === tableIndex && 
                                           selectedField?.fieldIndex === fieldIndex;
                          
                          return (
                            <button
                              key={field.sourceField}
                              onClick={() => selectField(tableIndex, fieldIndex)}
                              className={`
                                w-full p-3 border-b border-gray-200 last:border-0 
                                transition-colors text-left
                                ${isSelected 
                                  ? 'bg-blue-50 border-l-4 border-l-blue-600' 
                                  : 'hover:bg-gray-100 border-l-4 border-l-transparent'
                                }
                              `}
                            >
                              <div className="flex items-start justify-between gap-2 mb-1">
                                <div className="flex items-center gap-2 min-w-0 flex-1">
                                  <div className="w-1.5 h-1.5 rounded-full bg-gray-400 flex-shrink-0"></div>
                                  <span className="text-xs text-gray-900 truncate">
                                    {field.sourceField}
                                  </span>
                                </div>
                                {field.hasTransform && (
                                  <Badge className="bg-yellow-100 text-yellow-700 hover:bg-yellow-100 text-xs flex-shrink-0">
                                    Transform
                                  </Badge>
                                )}
                              </div>
                              <div className="flex items-center gap-1 ml-3.5">
                                <ArrowRight className="w-3 h-3 text-gray-400" />
                                <span className="text-xs text-gray-500 truncate">
                                  {field.targetField}
                                </span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col">
        {selectedTransform ? (
          <>
            <div className="border-b border-gray-200 bg-white p-6">
              <div className="flex items-center justify-between mb-2">
                <h1 className="text-2xl font-semibold text-gray-900">Transform Field</h1>
                {selectedTransform.tested && (
                  <Badge className="bg-green-100 text-green-700 hover:bg-green-100">
                    Tested
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <span className="font-medium">{selectedTableName}.{selectedTransform.sourceField}</span>
                <ArrowRight className="w-4 h-4" />
                <span className="font-medium">{selectedTransform.targetField}</span>
              </div>
            </div>

            <div className="flex-1 overflow-auto p-6 space-y-6">
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <label className="block text-sm font-medium text-gray-900 mb-3">
                  Describe how this field should be transformed
                </label>
                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="e.g., Convert account type values to uppercase and map 'Prospect' to 'PROSPECT', 'Customer' to 'CUSTOMER', and any other values to 'OTHER'"
                  className="min-h-32 resize-none"
                />
                <div className="mt-4 flex gap-2">
                  <Button className="bg-primary hover:bg-primary/90 text-white gap-2">
                    <RefreshCw className="w-4 h-4" />
                    Generate Transform
                  </Button>
                  <Button variant="outline">
                    Clear
                  </Button>
                </div>
              </div>

              {selectedTransform.sql && (
                <div className="bg-white rounded-xl border border-gray-200">
                  <div className="p-4 border-b border-gray-200 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <h3 className="text-sm font-semibold text-gray-900">Generated SQL</h3>
                      <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100 text-xs">
                        AI-Generated
                      </Badge>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowSQL(!showSQL)}
                      className="gap-2"
                    >
                      {showSQL ? (
                        <>
                          <ChevronDown className="w-4 h-4" />
                          Hide SQL
                        </>
                      ) : (
                        <>
                          <ChevronRight className="w-4 h-4" />
                          Show SQL
                        </>
                      )}
                    </Button>
                  </div>

                  {showSQL && (
                    <div className="p-4">
                      <pre className="text-xs font-mono text-gray-800 bg-gray-50 p-4 rounded border border-gray-200 overflow-x-auto">
                        {selectedTransform.sql}
                      </pre>
                    </div>
                  )}
                </div>
              )}

              {selectedTransform.sql && (
                <div className="bg-white rounded-xl border border-gray-200">
                  <div className="p-4 border-b border-gray-200 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-900">Test Transformation</h3>
                    <Button size="sm" variant="outline" className="gap-2">
                      <Play className="w-4 h-4" />
                      Run Test
                    </Button>
                  </div>

                  <div className="p-4">
                    <table className="w-full">
                      <thead className="border-b border-gray-200">
                        <tr>
                          <th className="text-left text-xs font-medium text-gray-700 pb-3">Before</th>
                          <th className="w-12"></th>
                          <th className="text-left text-xs font-medium text-gray-700 pb-3">After</th>
                        </tr>
                      </thead>
                      <tbody>
                        {testData.map((row, idx) => (
                          <tr key={idx} className="border-b border-gray-100 last:border-0">
                            <td className="py-3 text-sm text-gray-600">{row.before}</td>
                            <td className="py-3 text-center">
                              <ArrowRight className="w-4 h-4 text-gray-400 mx-auto" />
                            </td>
                            <td className="py-3 text-sm text-gray-900 font-medium">{row.after}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {!selectedTransform.hasTransform && (
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-blue-900 mb-1">
                        No transformation needed
                      </div>
                      <div className="text-xs text-blue-700">
                        This field can be mapped directly without transformation. If you need to add a transformation, describe the logic above.
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="border-t border-gray-200 bg-white p-6 flex justify-between">
              <Button variant="outline">
                Save Transformation
              </Button>
              <Button
                onClick={handleNext}
                className="bg-primary hover:bg-primary/90 text-white"
              >
                Continue to Validation
              </Button>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center p-6">
            <div className="text-center max-w-md">
              <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <ArrowRight className="w-8 h-8 text-gray-400" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                Select a field to transform
              </h3>
              <p className="text-sm text-gray-600">
                Choose a field from the left panel to define or edit its transformation logic.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
