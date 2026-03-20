import type { Metadata } from 'next'
import { DM_Sans, JetBrains_Mono } from 'next/font/google'
import './globals.css'

const dmSans = DM_Sans({ subsets: ['latin'], variable: '--font-dm-sans' })
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono' })

export const metadata: Metadata = {
  title: 'MINE - AI-Native Data Migration Automation',
  description: 'The autonomous engine for your data migration. Cut time and cost by 50–70% while reducing go-live risk.',
  viewport: 'width=device-width, initial-scale=1',
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

