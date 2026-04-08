import type { Metadata } from 'next'
import { DM_Sans, JetBrains_Mono } from 'next/font/google'
import './globals.css'

const dmSans = DM_Sans({ subsets: ['latin'], variable: '--font-dm-sans' })
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono' })

export const metadata: Metadata = {
  title: 'Settle — AI-Native Data Migration',
  description: 'Settle automates enterprise data migration. AI agents profile schemas, map fields, generate transformations, and validate data quality — cutting time and cost by 40–50%.',
  viewport: 'width=device-width, initial-scale=1',
  icons: {
    icon: '/images/logos/settle-logo-mark-dark.png',
    apple: '/images/logos/settle-logo-mark-dark.png',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={`h-full ${dmSans.variable} ${jetbrainsMono.variable}`}>
      <body className="h-full">{children}</body>
    </html>
  )
}

