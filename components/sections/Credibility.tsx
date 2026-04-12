export default function Credibility() {
  return (
    <section className="py-14 bg-[#0F172A]">
      <div className="max-w-3xl mx-auto px-6 text-center flex flex-col gap-4">
        <p className="text-xs font-semibold tracking-widest text-[#3B82F6] uppercase">
          Why this exists
        </p>
        <h2 className="text-xl font-bold text-white leading-snug tracking-tight">
          Built by migration specialists, not general-purpose AI.
        </h2>
        <p className="text-[#CBD5E1] text-base leading-relaxed">
          Settle was founded by a former Deloitte Technical Program Manager who led enterprise data migrations across multiple Fortune 500 companies — delivering 70+ system integrations and $50M+ in cumulative project value. Settle is built by a team that ran the exact data migration projects this platform is built to automate. The product is built from the inside out: every workflow reflects how enterprise migrations actually fail, and where automation can prevent it.
        </p>
        <div className="flex flex-wrap justify-center gap-6 pt-2">
          {[
            { value: '70+',          label: 'system integrations delivered' },
            { value: 'Fortune 500', label: 'client programs'               },
            { value: '$50M+',       label: 'cumulative project value'      },
          ].map(({ value, label }) => (
            <div key={label} className="flex flex-col items-center gap-1">
              <span className="text-2xl font-bold text-white">{value}</span>
              <span className="text-xs text-[#94A3B8] text-center max-w-[100px] leading-snug">
                {label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
