import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

interface GuideLayoutProps {
  title: string
  description: string
  children: React.ReactNode
}

export function GuideLayout({ title, description, children }: GuideLayoutProps) {
  return (
    <div className="flex-1 bg-gray-50 min-h-screen overflow-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <Link
          href="/app/support"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors mb-6"
        >
          <ChevronLeft className="w-4 h-4" />
          Back to Support
        </Link>

        <div className="mb-6">
          <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
          <p className="text-sm text-gray-500 mt-1">{description}</p>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl px-6 py-5">
          <div className="prose-settle">
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6 last:mb-0">
      <h2 className="text-base font-semibold text-gray-900 mb-2">{title}</h2>
      {children}
    </div>
  )
}

export function Paragraph({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-gray-600 leading-relaxed mb-3 last:mb-0">{children}</p>
}

export function BulletList({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="list-disc pl-5 mb-3 last:mb-0 space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="text-sm text-gray-600 leading-relaxed">{item}</li>
      ))}
    </ul>
  )
}
