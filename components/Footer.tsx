import Link from 'next/link'

export default function Footer() {
  return (
    <footer className="border-t border-slate-200 py-8 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">

        {/* Row 1 */}
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-blue-600 flex items-center justify-center shrink-0">
              <span className="text-white text-2xs font-bold leading-none">M</span>
            </div>
            <span className="text-slate-400 text-sm">© 2026 Mine.</span>
          </div>

          <div className="flex gap-6">
            <Link
              href="/migrate"
              className="text-slate-400 text-sm hover:text-slate-600 transition-colors"
            >
              Migrations
            </Link>
            <a
              href="https://calendly.com/mine-ai/demo"
              target="_blank"
              rel="noopener noreferrer"
              className="text-slate-400 text-sm hover:text-slate-600 transition-colors"
            >
              Book a Demo
            </a>
            <Link
              href="/login"
              className="text-slate-400 text-sm hover:text-slate-600 transition-colors"
            >
              Login
            </Link>
            <Link
              href="/privacy"
              className="text-slate-400 text-sm hover:text-slate-600 transition-colors"
            >
              Privacy
            </Link>
          </div>
        </div>

        {/* Row 2 */}
        <div className="text-center mt-2">
          <p className="text-slate-300 text-xs">
            Built for autonomous, AI-native data migration.
          </p>
        </div>

      </div>
    </footer>
  )
}
