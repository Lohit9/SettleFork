import ScrollReveal from '@/components/ui/ScrollReveal'

const MUTED_CARDS = [
  {
    title: 'Consultant-driven migrations',
    bullets: [
      'One-off mapping specs in decks and spreadsheets',
      'Knowledge locked in people, not in a product',
      'Teams rebuilt for every engagement',
      'Decisions buried in emails and slide decks',
      'Weeks of discovery before first deliverable',
    ],
  },
  {
    title: 'Legacy ETL & data tools',
    bullets: [
      'Rule-based, not agent-native',
      'Manual schema and mapping management',
      'Validation bolted on at the end',
      'No mapping rationale — just execution logs',
      'Days of pipeline config before first output',
    ],
  },
]

const MINE_BULLETS = [
  'Autonomous multi-agent migration engine',
  'AI-led schema understanding and field mapping',
  'AI-generated transformations and cleansing rules',
  'Validation engine that catches issues before production',
  'Full AI decision log per mapping and transformation',
  'First mapping proposals generated within the hour',
]

export default function Differentiation() {
  return (
    <section id="why" className="bg-[#F8FAFC] pt-24 pb-12 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">

        {/* Header */}
        <ScrollReveal>
          <h2 className="text-4xl font-bold text-[#0F172A] tracking-tight text-center mb-3">
            Why Settle is different
          </h2>
          <p className="text-[#64748B] text-[17px] text-center mb-14">
            Not another ETL tool. Not another consulting project.
          </p>
        </ScrollReveal>

        {/* Cards */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {MUTED_CARDS.map((card, i) => (
            <ScrollReveal key={card.title} delay={i * 0.1}>
              <div className="bg-white rounded-2xl p-8 border border-[#E2E8F0] h-full opacity-50 hover:-translate-y-1 hover:shadow-lg transition-all duration-300">
                <h3 className="text-lg font-bold text-[#475569] mb-5">{card.title}</h3>
                <ul className="space-y-3">
                  {card.bullets.map((bullet) => (
                    <li key={bullet} className="flex gap-3">
                      <span className="text-[#94A3B8] shrink-0 mt-0.5">×</span>
                      <span className="text-sm text-[#64748B] leading-relaxed">{bullet}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </ScrollReveal>
          ))}

          {/* Settle card */}
          <ScrollReveal delay={0.2}>
            <div className="bg-blue-50 rounded-2xl p-8 border border-[#2358D4] border-t-[4px] h-full hover:-translate-y-1 hover:shadow-lg transition-all duration-300">
              <span className="text-xs font-semibold uppercase tracking-wider text-[#2358D4] mb-2 block">
                Recommended
              </span>
              <h3 className="text-lg font-bold text-[#0F172A] mb-5">Settle</h3>
              <ul className="space-y-3">
                {MINE_BULLETS.map((bullet) => (
                  <li key={bullet} className="flex gap-3">
                    <span className="text-[#2358D4] font-bold shrink-0 mt-0.5">✓</span>
                    <span className="text-sm text-[#334155] leading-relaxed">{bullet}</span>
                  </li>
                ))}
              </ul>
            </div>
          </ScrollReveal>
        </div>

        {/* Footer quote */}
        <ScrollReveal delay={0.2}>
          <p className="text-[17px] text-[#64748B] italic text-center mt-10">
            Built to make migrations as routine as deploying a modern web service.
          </p>
        </ScrollReveal>

      </div>
    </section>
  )
}
