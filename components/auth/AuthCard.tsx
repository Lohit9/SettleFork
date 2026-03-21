import Link from 'next/link'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

interface AuthCardProps {
  children: React.ReactNode
  title: string
  subtitle?: string
  footer?: {
    text: string
    linkText: string
    linkHref: string
  }
}

export default function AuthCard({ children, title, subtitle, footer }: AuthCardProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="mb-8 flex justify-center">
          <Link href="/">
            <img
              src="/Mine Logo no background.png"
              alt="Mine - AI-Native Data Migration Automation"
              className="h-10 w-auto"
            />
          </Link>
        </div>

        {/* Card */}
        <Card>
          <CardHeader className="space-y-1 text-center">
            <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
            {subtitle && <p className="text-sm text-gray-600">{subtitle}</p>}
          </CardHeader>
          <CardContent className="space-y-6">
            {children}
            {footer && (
              <div className="mt-6 text-center text-sm text-gray-600">
                {footer.text}{' '}
                <Link href={footer.linkHref} className="font-medium text-blue-600 hover:text-blue-700">
                  {footer.linkText}
                </Link>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
