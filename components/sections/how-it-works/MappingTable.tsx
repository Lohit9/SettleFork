'use client'

const ROWS = [
  { source: 'customer_id',    target: 'AccountId',           conf: 98, transform: 'Direct map' },
  { source: 'cust_name',      target: 'Account.Name',        conf: 95, transform: 'Trim + Title Case' },
  { source: 'service_addr',   target: 'ServiceAddress__c',   conf: 72, transform: 'Address parse → Street' },
  { source: 'acct_status',    target: 'Status__c',           conf: 89, transform: 'Picklist align: A→Active' },
  { source: 'last_pickup_dt', target: 'LastServiceDate__c',  conf: 94, transform: 'DateTime → Date' },
  { source: 'monthly_rate',   target: 'MonthlyRevenue__c',   conf: 91, transform: 'Decimal(10,2) → Currency' },
]

function confColor(conf: number): string {
  if (conf > 90) return '#4ADE80'
  if (conf > 75) return '#F59E0B'
  return '#F87171'
}

export default function MappingTable() {
  return (
    <div className="bg-slate-900 rounded-xl overflow-hidden font-mono text-xs">
      {/* Title bar */}
      <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-slate-800">
        <div className="w-2 h-2 rounded-full bg-red-500" />
        <div className="w-2 h-2 rounded-full bg-amber-500" />
        <div className="w-2 h-2 rounded-full bg-green-500" />
        <span className="text-slate-500 text-xs ml-2">
          Auto-mapping — customers → Salesforce Account
        </span>
      </div>

      {/* Table */}
      <div className="px-4 py-3">
        {/* Header */}
        <div className="grid grid-cols-[1.4fr_0.3fr_1.4fr_0.55fr_1.6fr] border-b border-slate-800 pb-2 mb-1">
          {['Source', '', 'Target', 'Conf.', 'Transform'].map((h, i) => (
            <span key={i} className="text-slate-500 text-2xs uppercase tracking-widest">
              {h}
            </span>
          ))}
        </div>

        {/* Rows */}
        {ROWS.map((row) => (
          <div
            key={row.source}
            className={`grid grid-cols-[1.4fr_0.3fr_1.4fr_0.55fr_1.6fr] py-2 border-b border-slate-800 last:border-b-0 ${
              row.conf <= 75 ? 'bg-yellow-500/5' : ''
            }`}
          >
            <span className="text-blue-300">{row.source}</span>
            <span className="text-slate-600">→</span>
            <span className="text-cyan-300">{row.target}</span>
            <span className="flex items-center gap-1.5">
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: confColor(row.conf) }}
              />
              <span style={{ color: confColor(row.conf) }}>{row.conf}%</span>
            </span>
            <span className="text-slate-500 text-xs truncate">{row.transform}</span>
          </div>
        ))}

        {/* Summary */}
        <div className="flex gap-4 mt-3 pt-2.5 border-t border-slate-800">
          <span className="text-xs text-green-400">● 2,688 auto-mapped</span>
          <span className="text-xs text-yellow-400">● 47 need review</span>
          <span className="text-xs text-red-400">● 12 unmapped</span>
        </div>
      </div>
    </div>
  )
}
