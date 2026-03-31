import ScrollReveal from '@/components/ui/ScrollReveal'

const MUTED_CARDS = [
  {
    title: 'Consultant-driven migrations',
    bullets: [
      'One-off mapping specs in decks and spreadsheets',
      'Knowledge locked in people, not in a product',
      'Teams rebuilt for every engagement',
    ],
  },
  {
    title: 'Legacy ETL & data tools',
    bullets: [
      'Rule-based, not agent-native',
      'Manual schema and mapping management',
      'Validation bolted on at the end',
    ],
  },
]

const MINE_BULLETS = [
  'Autonomous multi-agent migration engine',
  'AI-led schema understanding and mapping',
  'Validation engine that catches issues before production',
]

export default function Differentiation() {
  return (
    <section id="why" className="bg-slate-50 py-24 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">

        {/* Header */}
        <ScrollReveal>
          <h2 className="text-4xl font-bold text-slate-900 tracking-tight text-center mb-3">
            Why Mine is different
          </h2>
          <p className="text-slate-500 text-base text-center mb-14">
            Not another ETL tool. Not another consulting project.
          </p>
        </ScrollReveal>

        {/* Cards */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {MUTED_CARDS.map((card, i) => (
            <ScrollReveal key={card.title} delay={i * 0.1}>
              <div className="bg-white rounded-2xl p-8 border border-slate-200 h-full opacity-75 hover:-translate-y-1 hover:shadow-lg transition-all duration-300">
                <h3 className="text-lg font-bold text-slate-600 mb-5">{card.title}</h3>
                <ul className="space-y-3">
                  {card.bullets.map((bullet) => (
                    <li key={bullet} className="flex gap-3">
                      <span className="text-slate-400 shrink-0 mt-0.5">×</span>
                      <span className="text-sm text-slate-500 leading-relaxed">{bullet}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </ScrollReveal>
          ))}

          {/* Mine card */}
          <ScrollReveal delay={0.2}>
            <div className="bg-white rounded-2xl p-8 border border-blue-600 border-t-[3px] h-full hover:-translate-y-1 hover:shadow-lg transition-all duration-300">
              <h3 className="text-lg font-bold text-slate-900 mb-5">Mine</h3>
              <ul className="space-y-3">
                {MINE_BULLETS.map((bullet) => (
                  <li key={bullet} className="flex gap-3">
                    <span className="text-blue-600 font-bold shrink-0 mt-0.5">✓</span>
                    <span className="text-sm text-slate-700 leading-relaxed">{bullet}</span>
                  </li>
                ))}
              </ul>
            </div>
          </ScrollReveal>
        </div>

        {/* Footer quote */}
        <ScrollReveal delay={0.2}>
          <p className="text-base text-slate-500 italic text-center mt-10">
            Built to make migrations as routine as deploying a modern web service.
          </p>
        </ScrollReveal>

      </div>
    </section>
  )
}
