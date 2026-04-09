import Link from 'next/link'
import Image from 'next/image'

export default function Footer() {
  return (
    <footer className="border-t border-[#E2E8F0] bg-white">
      <div className="max-w-6xl mx-auto px-6 py-12">

        {/* Top row: logo + tagline left, three link columns right */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 pb-10 border-b border-[#E2E8F0]">

          {/* Brand column */}
          <div className="flex flex-col gap-3">
            <Link href="/">
              <Image
                src="/images/logos/settle-logo-full.svg"
                alt="Settle"
                width={100}
                height={28}
                className="h-7 w-auto"
              />
            </Link>
            <p className="text-sm text-[#64748B] leading-relaxed max-w-[200px]">
              Built for autonomous, AI-native data migration.
            </p>
          </div>

          {/* Product column */}
          <div className="flex flex-col gap-3">
            <p className="text-xs font-semibold tracking-widest text-[#94A3B8] uppercase">
              Product
            </p>
            <nav className="flex flex-col gap-2">
              <Link href="/how-it-works"
                    className="text-sm text-[#64748B] hover:text-[#0F172A] transition-colors">
                How it works
              </Link>
              <Link href="/migrate"
                    className="text-sm text-[#64748B] hover:text-[#0F172A] transition-colors">
                Migration directory
              </Link>
              <Link href="/request-access"
                    className="text-sm text-[#64748B] hover:text-[#0F172A] transition-colors">
                Request access
              </Link>
            </nav>
          </div>

          {/* Migrations column */}
          <div className="flex flex-col gap-3">
            <p className="text-xs font-semibold tracking-widest text-[#94A3B8] uppercase">
              Migrations
            </p>
            <nav className="flex flex-col gap-2">
              <Link href="/migrate?source=salesforce"
                    className="text-sm text-[#64748B] hover:text-[#0F172A] transition-colors">
                Salesforce migrations
              </Link>
              <Link href="/migrate?source=sap"
                    className="text-sm text-[#64748B] hover:text-[#0F172A] transition-colors">
                SAP migrations
              </Link>
              <Link href="/migrate?source=oracle"
                    className="text-sm text-[#64748B] hover:text-[#0F172A] transition-colors">
                Oracle migrations
              </Link>
              <Link href="/migrate?source=netsuite"
                    className="text-sm text-[#64748B] hover:text-[#0F172A] transition-colors">
                NetSuite migrations
              </Link>
            </nav>
          </div>

          {/* Company column */}
          <div className="flex flex-col gap-3">
            <p className="text-xs font-semibold tracking-widest text-[#94A3B8] uppercase">
              Company
            </p>
            <nav className="flex flex-col gap-2">
              <Link href="https://calendly.com/settle-ai/demo"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-[#64748B] hover:text-[#0F172A] transition-colors">
                Book a demo
              </Link>
              <Link href="/privacy"
                    className="text-sm text-[#64748B] hover:text-[#0F172A] transition-colors">
                Privacy policy
              </Link>
              <Link href="/login"
                    className="text-sm text-[#64748B] hover:text-[#0F172A] transition-colors">
                Login
              </Link>
            </nav>
          </div>

        </div>

        {/* Bottom row: copyright left, tagline right */}
        <div className="flex flex-col sm:flex-row items-center justify-between pt-6 gap-2">
          <p className="text-xs text-[#94A3B8]">
            © {new Date().getFullYear()} Settle. All rights reserved.
          </p>
          <p className="text-xs text-[#94A3B8] italic">
            Consider it settled.
          </p>
        </div>

      </div>
    </footer>
  )
}
