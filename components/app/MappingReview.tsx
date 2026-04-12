'use client'

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { X, Check, Edit, Plus, AlertCircle, ChevronDown, ChevronRight, ArrowRight } from '@/components/icons';
import { useRouter } from 'next/navigation';

interface MappingReviewProps {
  projectId: string;
}

type MappingStatus = 'approved' | 'needs-review' | 'unmapped';

interface FieldMapping {
  sourceField: string;
  targetField: string;
  confidence: number;
  status: MappingStatus;
  reasoning?: string;
  similarFields?: string[];
  typeCompatibility?: string;
  exampleValues?: { source: string; target: string }[];
}

interface TableMapping {
  sourceTable: string;
  targetTable: string;
  confidence: number;
  status: MappingStatus;
  fieldMappings: FieldMapping[];
}

const mockMappings: TableMapping[] = [
  {
    sourceTable: 'Account',
    targetTable: 'CUSTOMER',
    confidence: 92,
    status: 'approved',
    fieldMappings: [
      {
        sourceField: 'Id',
        targetField: 'CUSTOMER_ID',
        confidence: 85,
        status: 'needs-review',
        reasoning: 'Primary key mapping with type conversion required',
        similarFields: ['CUSTOMER.ID', 'CUSTOMER.CUST_ID'],
        typeCompatibility: 'Needs conversion: VARCHAR(18) → CHAR(10)',
        exampleValues: [
          { source: '0013600001aBC2DEF', target: 'CUST000123' },
        ]
      },
      {
        sourceField: 'Name',
        targetField: 'CUSTOMER_NAME',
        confidence: 98,
        status: 'approved',
        reasoning: 'Direct semantic match with identical business purpose',
        similarFields: ['CUSTOMER.NAME', 'CUSTOMER.CUST_NAME'],
        typeCompatibility: 'Compatible: VARCHAR(255) → VARCHAR(255)',
        exampleValues: [
          { source: 'Acme Corporation', target: 'Acme Corporation' },
        ]
      },
      {
        sourceField: 'Type',
        targetField: 'CUSTOMER_TYPE',
        confidence: 85,
        status: 'needs-review',
        reasoning: 'Semantic match, but value transformation may be required',
        similarFields: ['CUSTOMER.TYPE_CODE', 'CUSTOMER.ACCOUNT_TYPE'],
        typeCompatibility: 'Compatible: VARCHAR(40) → VARCHAR(40)',
        exampleValues: [
          { source: 'Prospect', target: 'PROSPECT' },
        ]
      },
      {
        sourceField: 'Industry',
        targetField: 'INDUSTRY_CODE',
        confidence: 72,
        status: 'needs-review',
        reasoning: 'Partial match - target uses standardized industry codes',
        similarFields: ['CUSTOMER.INDUSTRY', 'CUSTOMER.SECTOR'],
        typeCompatibility: 'Needs review: VARCHAR(40) → VARCHAR(40) with code mapping',
        exampleValues: [
          { source: 'Technology', target: 'TECH' },
        ]
      },
      {
        sourceField: 'AnnualRevenue',
        targetField: 'ANNUAL_REVENUE',
        confidence: 92,
        status: 'approved',
        reasoning: 'Direct semantic match with compatible data types',
        similarFields: ['CUSTOMER.REVENUE', 'CUSTOMER.YEARLY_REVENUE'],
        typeCompatibility: 'Compatible: DECIMAL(18,2) → DECIMAL(18,2)',
        exampleValues: [
          { source: '1500000.00', target: '1500000.00' },
        ]
      },
    ]
  },
  {
    sourceTable: 'Contact',
    targetTable: 'CONTACT_PERSON',
    confidence: 94,
    status: 'approved',
    fieldMappings: [
      {
        sourceField: 'Id',
        targetField: 'CONTACT_ID',
        confidence: 85,
        status: 'needs-review',
        reasoning: 'Primary key mapping with type conversion required',
        typeCompatibility: 'Needs conversion: VARCHAR(18) → CHAR(10)',
      },
      {
        sourceField: 'AccountId',
        targetField: 'CUSTOMER_ID',
        confidence: 90,
        status: 'approved',
        reasoning: 'Foreign key relationship mapping',
        typeCompatibility: 'Needs conversion: VARCHAR(18) → CHAR(10)',
      },
      {
        sourceField: 'FirstName',
        targetField: 'FIRST_NAME',
        confidence: 95,
        status: 'approved',
        reasoning: 'Direct field name and semantic match',
        typeCompatibility: 'Compatible: VARCHAR(40) → VARCHAR(40)',
      },
      {
        sourceField: 'LastName',
        targetField: 'LAST_NAME',
        confidence: 95,
        status: 'approved',
        reasoning: 'Direct field name and semantic match',
        typeCompatibility: 'Compatible: VARCHAR(80) → VARCHAR(80)',
      },
      {
        sourceField: 'Email',
        targetField: 'EMAIL_ADDRESS',
        confidence: 88,
        status: 'needs-review',
        reasoning: 'Semantic match with different field naming convention',
        typeCompatibility: 'Compatible: VARCHAR(80) → VARCHAR(80)',
      },
    ]
  }
];

export function MappingReview({ projectId }: MappingReviewProps) {
  const router = useRouter();
  const [mappings, setMappings] = useState(mockMappings);
  const [selectedMapping, setSelectedMapping] = useState<FieldMapping | null>(null);
  const [filter, setFilter] = useState<'all' | 'needs-review' | 'high-confidence' | 'unmapped'>('needs-review');
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set(['Account', 'Contact']));

  const toggleTable = (tableName: string) => {
    const newExpanded = new Set(expandedTables);
    if (newExpanded.has(tableName)) {
      newExpanded.delete(tableName);
    } else {
      newExpanded.add(tableName);
    }
    setExpandedTables(newExpanded);
  };

  const getConfidenceColor = (confidence: number) => {
    if (confidence >= 90) return 'text-green-700 bg-green-50 border-green-200';
    if (confidence >= 70) return 'text-yellow-700 bg-yellow-50 border-yellow-200';
    return 'text-red-700 bg-red-50 border-red-200';
  };

  const getStatusBadge = (status: MappingStatus) => {
    switch (status) {
      case 'approved':
        return <Badge className="bg-green-100 text-green-700 hover:bg-green-100 text-xs">Approved</Badge>;
      case 'needs-review':
        return <Badge className="bg-yellow-100 text-yellow-700 hover:bg-yellow-100 text-xs">Needs Review</Badge>;
      case 'unmapped':
        return <Badge className="bg-gray-100 text-gray-700 hover:bg-gray-100 text-xs">Unmapped</Badge>;
    }
  };

  const filteredMappings = mappings.map(tableMapping => ({
    ...tableMapping,
    fieldMappings: tableMapping.fieldMappings.filter(fm => {
      if (filter === 'all') return true;
      if (filter === 'needs-review') return fm.status === 'needs-review' || fm.confidence < 90;
      if (filter === 'high-confidence') return fm.confidence >= 90;
      if (filter === 'unmapped') return fm.status === 'unmapped';
      return true;
    })
  })).filter(tm => tm.fieldMappings.length > 0);

  const approveFieldMapping = (sourceTable: string, sourceField: string) => {
    setMappings(mappings.map(tm => 
      tm.sourceTable === sourceTable
        ? {
            ...tm,
            fieldMappings: tm.fieldMappings.map(fm =>
              fm.sourceField === sourceField ? { ...fm, status: 'approved' as MappingStatus } : fm
            )
          }
        : tm
    ));
  };

  const handleNext = () => {
    router.push(`/app/projects/${projectId}/transform`);
  };

  return (
    <div className="flex-1 bg-gray-50 flex">
      <div className="flex-1 flex flex-col">
        <div className="border-b border-gray-200 bg-white p-6">
          <h1 className="text-2xl font-semibold text-gray-900 mb-4">Mapping Review</h1>
          
          <div className="flex gap-2">
            <Button
              variant={filter === 'needs-review' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter('needs-review')}
              className={filter === 'needs-review' ? 'bg-primary hover:bg-primary/90' : ''}
            >
              Needs Review
            </Button>
            <Button
              variant={filter === 'high-confidence' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter('high-confidence')}
              className={filter === 'high-confidence' ? 'bg-primary hover:bg-primary/90' : ''}
            >
              High Confidence
            </Button>
            <Button
              variant={filter === 'unmapped' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter('unmapped')}
              className={filter === 'unmapped' ? 'bg-primary hover:bg-primary/90' : ''}
            >
              Unmapped
            </Button>
            <Button
              variant={filter === 'all' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter('all')}
              className={filter === 'all' ? 'bg-primary hover:bg-primary/90' : ''}
            >
              All
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-6">
          <div className="grid grid-cols-[1fr_80px_1fr] gap-4 mb-6">
            <div className="text-sm font-semibold text-blue-600">SALESFORCE_PROD</div>
            <div></div>
            <div className="text-sm font-semibold text-blue-600">SAP_S4HANA</div>
          </div>

          <div className="space-y-4">
            {filteredMappings.map((tableMapping) => (
              <div key={tableMapping.sourceTable} className="bg-white rounded-xl border border-gray-200">
                <div className="border-b border-gray-200 bg-gray-50">
                  <div className="grid grid-cols-[1fr_80px_1fr] gap-4 p-4 items-center">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => toggleTable(tableMapping.sourceTable)}
                        className="flex items-center gap-2 hover:text-blue-600 transition-colors"
                      >
                        {expandedTables.has(tableMapping.sourceTable) ? (
                          <ChevronDown className="w-4 h-4 text-gray-500" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-gray-500" />
                        )}
                        <span className="text-sm font-semibold text-gray-900">
                          {tableMapping.sourceTable}
                        </span>
                      </button>
                      <span className="text-xs text-gray-500">
                        {tableMapping.fieldMappings.length} fields
                      </span>
                    </div>

                    <div className="flex justify-center">
                      <div className="flex items-center gap-2">
                        <div className="h-px w-8 bg-gray-300"></div>
                        <ArrowRight className="w-4 h-4 text-gray-400" />
                        <div className="h-px w-8 bg-gray-300"></div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <span className="text-sm font-semibold text-gray-900">
                        {tableMapping.targetTable}
                      </span>
                      <div className={`text-xs px-2 py-0.5 rounded border ${getConfidenceColor(tableMapping.confidence)}`}>
                        {tableMapping.confidence}%
                      </div>
                      {getStatusBadge(tableMapping.status)}
                    </div>
                  </div>
                </div>

                {expandedTables.has(tableMapping.sourceTable) && (
                  <div className="p-4 space-y-2">
                    {tableMapping.fieldMappings.map((fieldMapping) => (
                      <div
                        key={fieldMapping.sourceField}
                        className="grid grid-cols-[1fr_80px_1fr_100px] gap-4 items-center p-3 rounded-lg border border-gray-200 hover:border-blue-600 hover:bg-blue-50 transition-all cursor-pointer"
                        onClick={() => setSelectedMapping(fieldMapping)}
                      >
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full bg-gray-300"></div>
                          <span className="text-sm text-gray-900">{fieldMapping.sourceField}</span>
                        </div>

                        <div className="flex flex-col items-center gap-1">
                          <div className="flex items-center gap-1">
                            <div className="h-px flex-1 bg-gray-300"></div>
                            <ArrowRight className="w-3 h-3 text-gray-400" />
                            <div className="h-px flex-1 bg-gray-300"></div>
                          </div>
                          <div className={`text-xs px-1.5 py-0.5 rounded border text-center ${getConfidenceColor(fieldMapping.confidence)}`}>
                            {fieldMapping.confidence}%
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full bg-gray-300"></div>
                          <span className="text-sm text-gray-900">{fieldMapping.targetField}</span>
                        </div>

                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              approveFieldMapping(tableMapping.sourceTable, fieldMapping.sourceField);
                            }}
                            className="h-7 w-7 p-0 text-green-600 hover:text-green-700 hover:bg-green-50"
                          >
                            <Check className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => e.stopPropagation()}
                            className="h-7 w-7 p-0 text-gray-600 hover:text-gray-700 hover:bg-gray-100"
                          >
                            <Edit className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => e.stopPropagation()}
                            className="h-7 w-7 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="mt-4">
            <Button variant="outline" className="gap-2">
              <Plus className="w-4 h-4" />
              Add New Mapping
            </Button>
          </div>
        </div>

        <div className="border-t border-gray-200 bg-white p-6 flex justify-end">
          <Button
            onClick={handleNext}
            className="bg-primary hover:bg-primary/90 text-white"
          >
            Proceed to Transform
          </Button>
        </div>
      </div>

      {selectedMapping && (
        <div className="w-96 bg-white border-l border-gray-200 flex flex-col">
          <div className="p-6 border-b border-gray-200 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Mapping Details</h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedMapping(null)}
            >
              <X className="w-4 h-4" />
            </Button>
          </div>

          <div className="flex-1 overflow-auto p-6 space-y-6">
            <div>
              <div className="text-xs text-gray-500 mb-1">Source Field</div>
              <div className="text-sm font-medium text-gray-900">{selectedMapping.sourceField}</div>
            </div>

            <div>
              <div className="text-xs text-gray-500 mb-1">Target Field</div>
              <div className="text-sm font-medium text-gray-900">{selectedMapping.targetField}</div>
            </div>

            <div>
              <div className="text-xs text-gray-500 mb-2">Confidence</div>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${
                      selectedMapping.confidence >= 90
                        ? 'bg-green-500'
                        : selectedMapping.confidence >= 70
                        ? 'bg-yellow-500'
                        : 'bg-red-500'
                    }`}
                    style={{ width: `${selectedMapping.confidence}%` }}
                  />
                </div>
                <span className="text-sm font-medium text-gray-900">
                  {selectedMapping.confidence}%
                </span>
              </div>
            </div>

            {selectedMapping.reasoning && (
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <div className="text-xs font-medium text-blue-900 mb-1">AI-Generated</div>
                    <div className="text-xs text-blue-700">{selectedMapping.reasoning}</div>
                  </div>
                </div>
              </div>
            )}

            {selectedMapping.similarFields && selectedMapping.similarFields.length > 0 && (
              <div>
                <div className="text-xs font-medium text-gray-900 mb-2">Similar Fields Considered</div>
                <div className="space-y-1">
                  {selectedMapping.similarFields.map((field, idx) => (
                    <div key={idx} className="text-xs text-gray-600 bg-gray-50 px-3 py-1.5 rounded">
                      {field}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {selectedMapping.typeCompatibility && (
              <div>
                <div className="text-xs font-medium text-gray-900 mb-2">Type Compatibility</div>
                <div className="text-xs text-gray-600 bg-gray-50 px-3 py-2 rounded">
                  {selectedMapping.typeCompatibility}
                </div>
              </div>
            )}

            {selectedMapping.exampleValues && selectedMapping.exampleValues.length > 0 && (
              <div>
                <div className="text-xs font-medium text-gray-900 mb-2">Example Values</div>
                <div className="space-y-2">
                  {selectedMapping.exampleValues.map((example, idx) => (
                    <div key={idx} className="text-xs bg-gray-50 rounded p-2">
                      <div className="text-gray-500 mb-1">Source:</div>
                      <div className="text-gray-900 mb-2">{example.source}</div>
                      <div className="text-gray-500 mb-1">Target:</div>
                      <div className="text-gray-900">{example.target}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="p-6 border-t border-gray-200 space-y-2">
            <Button
              className="w-full bg-green-600 hover:bg-green-700 text-white"
              onClick={() => {
                const tableMapping = mappings.find(tm => 
                  tm.fieldMappings.some(fm => fm.sourceField === selectedMapping.sourceField)
                );
                if (tableMapping) {
                  approveFieldMapping(tableMapping.sourceTable, selectedMapping.sourceField);
                }
                setSelectedMapping(null);
              }}
            >
              Accept Mapping
            </Button>
            <Button variant="outline" className="w-full">
              Edit Mapping
            </Button>
            <Button variant="outline" className="w-full text-red-600 hover:text-red-700 hover:bg-red-50">
              Remove Mapping
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
