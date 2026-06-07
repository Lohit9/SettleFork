const CALENDLY = 'https://calendly.com/settle-ai/demo'

const FILE_ICON = {
  viewBox: '0 0 24 24',
  width: 15,
  height: 15,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

const SCRIPTS = [
  { name: '00_pre_migration_checklist.sql', badge: 'CHECKLIST' },
  { name: '01_stage_load.sql', badge: 'STAGING' },
  { name: '02_promote_to_production.sql', badge: 'PROMOTE' },
  { name: '03_rollback.sql', badge: 'ROLLBACK' },
]

const FILES = [
  { name: 'accounts.csv', badge: 'v1.7' },
  { name: 'customers.csv', badge: 'v1.6' },
  { name: 'branches.csv', badge: 'v1.5' },
  { name: 'commodity_codes.csv', badge: 'v1.4' },
]

function FileIcon() {
  return (
    <svg {...FILE_ICON}>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
    </svg>
  )
}

function FileRow({ name, badge, upper }: { name: string; badge: string; upper?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-[color:var(--line)] px-3 py-2">
      <span className="shrink-0 text-[color:var(--ink-3)]">
        <FileIcon />
      </span>
      <span className="mono text-xs text-[color:var(--ink)] truncate flex-1">{name}</span>
      <span className={`chip chip-gray shrink-0 ${upper ? 'uppercase' : ''}`}>{badge}</span>
    </div>
  )
}

export default function ExportStage() {
  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">

        {/* Left — sequenced ETL scripts */}
        <div>
          <div className="flex items-start gap-3 mb-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[color:var(--ink)] text-white">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="8 6 3 12 8 18" />
                <polyline points="16 6 21 12 16 18" />
              </svg>
            </span>
            <div>
              <h4 className="text-sm font-semibold text-[color:var(--ink)]">Sequenced ETL scripts</h4>
              <p className="text-xs text-[color:var(--ink-3)]">Ready to run, in order.</p>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {SCRIPTS.map((f) => (
              <FileRow key={f.name} name={f.name} badge={f.badge} upper />
            ))}
          </div>
          <p className="mono text-[11px] text-[color:var(--ink-3)] mt-2">
            + 8 more files · <span className="text-[color:var(--blue)] cursor-pointer">Show all</span>
          </p>
        </div>

        {/* Right — import-ready files */}
        <div>
          <div className="flex items-start gap-3 mb-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[color:var(--ink)] text-white">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2 2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            </span>
            <div>
              <h4 className="text-sm font-semibold text-[color:var(--ink)]">Import-ready files</h4>
              <p className="text-xs text-[color:var(--ink-3)]">Production-ready, every transformation applied.</p>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {FILES.map((f) => (
              <FileRow key={f.name} name={f.name} badge={f.badge} />
            ))}
          </div>
          <p className="mono text-[11px] text-[color:var(--ink-3)] mt-2">
            + 3 more files · <span className="text-[color:var(--blue)] cursor-pointer">Show all</span>
          </p>
        </div>

      </div>

      <div className="flex justify-end mt-5">
        <a href={CALENDLY} target="_blank" rel="noopener noreferrer" className="btn btn-primary">
          Book a demo
        </a>
      </div>
    </div>
  )
}
