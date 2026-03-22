'use client'

import { useState } from 'react'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'

const NAV_LINKS = [
  { label: 'How It Works', href: '/#how' },
  { label: 'Use Cases',    href: '/#why' },
]

const CALENDLY = 'https://calendly.com/mine-ai/demo'

export default function Header() {
  const [mobileOpen, setMobileOpen] = useState(false)

  const closeMenu = () => setMobileOpen(false)

  return (
    <motion.header
      className="sticky top-0 z-50 bg-white/85 backdrop-blur-xl border-b border-slate-200/30"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
    >
      <div className="max-w-7xl mx-auto px-6 lg:px-12">
        <div className="flex justify-between items-center h-16">

          {/* Logo */}
          <Link href="/" className="flex items-center gap-2.5" onClick={closeMenu}>
            <img
              src="/Mine Logo no background.png"
              alt="Mine"
              className="h-7 w-auto"
            />
            <span className="text-lg font-bold tracking-tight text-[#0F172A]">Mine</span>
          </Link>

          {/* Desktop nav */}
          <div className="hidden lg:flex items-center gap-6">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm font-medium text-[#94A3B8] hover:text-[#334155] transition-colors"
              >
                {link.label}
              </Link>
            ))}

            {/* Login — understated text link */}
            <Link
              href="/login"
              className="text-sm font-medium text-[#94A3B8] hover:text-[#334155] transition-colors"
            >
              Login
            </Link>

            {/* Book a Demo — secondary outlined */}
            <a
              href={CALENDLY}
              target="_blank"
              rel="noopener noreferrer"
              className="border border-[#CBD5E1] text-[#334155] hover:border-[#2563EB] hover:text-[#2563EB] text-sm font-medium px-5 py-2 rounded-lg transition-all"
            >
              Book a Demo
            </a>

            {/* Request Access — primary, most prominent */}
            <Link
              href="/request-access"
              className="bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-sm font-semibold px-5 py-2 rounded-lg transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-blue-600/25"
            >
              Request Access
            </Link>
          </div>

          {/* Mobile hamburger */}
          <button
            className="lg:hidden flex flex-col justify-center gap-1.5 w-8 h-8 p-1"
            onClick={() => setMobileOpen((o) => !o)}
            aria-label="Toggle menu"
          >
            <span className={`block h-0.5 bg-[#334155] transition-all duration-300 ${mobileOpen ? 'rotate-45 translate-y-2' : ''}`} />
            <span className={`block h-0.5 bg-[#334155] transition-all duration-300 ${mobileOpen ? 'opacity-0' : ''}`} />
            <span className={`block h-0.5 bg-[#334155] transition-all duration-300 ${mobileOpen ? '-rotate-45 -translate-y-2' : ''}`} />
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: 'hidden' }}
            className="lg:hidden border-t border-slate-200/50 bg-white/95 backdrop-blur-xl"
          >
            <div className="px-6 py-5 flex flex-col gap-4">
              {NAV_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={closeMenu}
                  className="text-sm font-medium text-[#475569] hover:text-[#0F172A] transition-colors py-1"
                >
                  {link.label}
                </Link>
              ))}
              <div className="pt-2 flex flex-col gap-3">
                <Link
                  href="/request-access"
                  onClick={closeMenu}
                  className="w-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-sm font-semibold px-5 py-3 rounded-lg transition-all text-center"
                >
                  Request Access
                </Link>
                <a
                  href={CALENDLY}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={closeMenu}
                  className="w-full border border-[#CBD5E1] text-[#334155] text-sm font-medium px-5 py-3 rounded-lg transition-all text-center"
                >
                  Book a Demo
                </a>
                <Link
                  href="/login"
                  onClick={closeMenu}
                  className="text-sm font-medium text-[#94A3B8] hover:text-[#334155] transition-colors text-center py-1"
                >
                  Login
                </Link>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.header>
  )
}
