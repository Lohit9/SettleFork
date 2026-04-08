import Link from 'next/link'

export default function Footer() {
  return (
    <footer className="border-t border-[#E2E8F0] py-8 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">

        {/* Row 1 */}
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-[#2358D4] flex items-center justify-center shrink-0">
              <span className="text-white text-[10px] font-bold leading-none">S</span>
            </div>
            <span className="text-[#94A3B8] text-sm">© 2026 Settle.</span>
          </div>

          <div className="flex gap-6">
            <Link
              href="/migrate"
              className="text-[#94A3B8] text-sm hover:text-[#475569] transition-colors"
            >
              Migrations
            </Link>
            <a
              href="https://calendly.com/settle-ai/demo"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#94A3B8] text-sm hover:text-[#475569] transition-colors"
            >
              Book a Demo
            </a>
            <Link
              href="/login"
              className="text-[#94A3B8] text-sm hover:text-[#475569] transition-colors"
            >
              Login
            </Link>
            <Link
              href="/privacy"
              className="text-[#94A3B8] text-sm hover:text-[#475569] transition-colors"
            >
              Privacy
            </Link>
          </div>
        </div>

        {/* Row 2 */}
        <div className="text-center mt-2">
          <p className="text-[#CBD5E1] text-xs">
            Built for autonomous, AI-native data migration.
          </p>
        </div>

      </div>
    </footer>
  )
}
