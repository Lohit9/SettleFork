'use client'

import Link from 'next/link'
import { motion } from 'framer-motion'

export default function Header() {
  return (
    <motion.header
      className="sticky top-0 z-50 bg-white/85 backdrop-blur-xl border-b border-slate-200/30"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
    >
      <div className="max-w-7xl mx-auto px-6 lg:px-12">
        <div className="flex justify-between items-center h-16">
          <Link href="/" className="flex items-center gap-2.5">
            <img
              src="/Mine Logo no background.png"
              alt="MINE - AI-Native Data Migration Automation"
              className="h-7 w-auto"
              style={{ filter: 'hue-rotate(0deg) saturate(1)' }}
            />
            <span className="text-lg font-bold tracking-tight text-[#0F172A]">
              MINE
            </span>
          </Link>

          <div className="flex items-center gap-6">
            <a href="#how" className="text-sm font-medium text-[#64748B] hover:text-[#334155] transition-colors hidden md:block">How it works</a>
            <a href="#why" className="text-sm font-medium text-[#64748B] hover:text-[#334155] transition-colors hidden md:block">Why Mine</a>
            <a href="#faq" className="text-sm font-medium text-[#64748B] hover:text-[#334155] transition-colors hidden md:block">FAQ</a>
            <Link
              href="/login"
              className="text-sm font-medium text-[#64748B] hover:text-[#334155] transition-colors"
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className="bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-sm font-semibold px-5 py-2 rounded-lg transition-all hover:shadow-lg hover:shadow-blue-600/20 hover:-translate-y-0.5"
            >
              Get started
            </Link>
          </div>
        </div>
      </div>
    </motion.header>
  )
}

