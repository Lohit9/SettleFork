const CALENDLY = 'https://calendly.com/settle-ai/demo'

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
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 2h5l4 4v8h-9z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M8.5 2v4h4" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function FileRow({ name, badge, version }: { name: string; badge: string; version?: boolean }) {
  return (
    <div className="flex h-[35px] items-center gap-[10px] rounded-[9px] border border-[color:var(--line)] bg-[color:var(--surface)] px-3">
      <span className="flex shrink-0 text-[color:var(--ink-3)]">
        <FileIcon />
      </span>
      <span className="mono min-w-0 flex-1 truncate text-[11.5px] font-medium text-[color:var(--ink)]">{name}</span>
      {version ? (
        <span className="mono ml-auto shrink-0 rounded-[5px] border border-[color:var(--line)] px-[7px] py-[3px] text-[10px] text-[color:var(--ink-3)]">
          {badge}
        </span>
      ) : (
        <span className="mono ml-auto shrink-0 rounded-[5px] border border-[color:var(--line)] px-[6px] py-[3px] text-[9px] font-bold tracking-[0.06em] text-[color:var(--ink-3)]">
          {badge}
        </span>
      )}
    </div>
  )
}

export default function ExportStage() {
  return (
    <div className="flex h-full flex-col">
      <div className="grid flex-1 grid-cols-2 items-start gap-[18px] overflow-hidden px-5 pt-7 pb-[2px]">
        {/* sequenced ETL scripts */}
        <div className="flex min-w-0 flex-col gap-[11px]">
          <div className="flex items-start gap-[11px]">
            <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] bg-[color:var(--ink)] text-white">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 1.8l5.4 3.1v6.2L8 14.2 2.6 11.1V4.9z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                <path d="M2.6 4.9L8 8l5.4-3.1M8 8v6.2" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
              </svg>
            </span>
            <div>
              <div className="text-[13.5px] font-[650] tracking-[-0.01em] text-[color:var(--ink)]">Sequenced ETL scripts</div>
              <div className="mt-[3px] text-[11.5px] leading-[1.4] text-[color:var(--ink-3)]">Ready to run, in order.</div>
            </div>
          </div>
          <div className="mt-4 flex flex-col gap-[6px]">
            {SCRIPTS.map((f) => (
              <FileRow key={f.name} name={f.name} badge={f.badge} />
            ))}
            <div className="mono px-[2px] pt-2 text-[11px] text-[color:var(--blue-press)]">+ 8 more files · Show all</div>
          </div>
        </div>

        {/* import-ready files */}
        <div className="flex min-w-0 flex-col gap-[11px] border-l border-[color:var(--line)] pl-[18px]">
          <div className="flex items-start gap-[11px]">
            <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] bg-[color:var(--ink)] text-white">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3.5 2h5l4 4v8h-9z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                <path d="M8.5 2v4h4M8 8v3.4M6.2 9.6L8 11.4l1.8-1.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div>
              <div className="text-[13.5px] font-[650] tracking-[-0.01em] text-[color:var(--ink)]">Import-ready files</div>
              <div className="mt-[3px] text-[11.5px] leading-[1.4] text-[color:var(--ink-3)]">Production-ready, every transformation applied.</div>
            </div>
          </div>
          <div className="mt-4 flex flex-col gap-[6px]">
            {FILES.map((f) => (
              <FileRow key={f.name} name={f.name} badge={f.badge} version />
            ))}
            <div className="mono px-[2px] pt-2 text-[11px] text-[color:var(--blue-press)]">+ 3 more files · Show all</div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-[14px] border-t border-[color:var(--line)] bg-[color:var(--surface-2)] px-5 py-[13px]">
        <a
          href={CALENDLY}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-primary"
          style={{ height: 40, padding: '0 22px', fontSize: 13.5 }}
        >
          Book a demo
        </a>
      </div>
    </div>
  )
}
