import ScrollReveal from '@/components/ui/ScrollReveal'
import AnimatedCounter from '@/components/ui/AnimatedCounter'

const METRICS = [
  { end: 70,  suffix: '%',  prefix: '',    label: 'faster migration planning' },
  { end: 90,  suffix: '%+', prefix: '',    label: 'auto-mapped fields'        },
  { end: 50,  suffix: '%',  prefix: '40–', label: 'cost reduction'            },
]

export default function MetricsBar() {
  return (
    <section className="bg-slate-900 py-12 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-8 text-center">
        {METRICS.map((metric, i) => (
          <ScrollReveal key={metric.label} delay={i * 0.1}>
            <div className="text-5xl font-bold text-white tracking-tight">
              <AnimatedCounter end={metric.end} suffix={metric.suffix} prefix={metric.prefix} />
            </div>
            <p className="text-slate-500 text-sm mt-2">{metric.label}</p>
          </ScrollReveal>
        ))}
      </div>
    </section>
  )
}
