import Link from 'next/link'
import Image from 'next/image'

export default function ProjectNotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="text-center max-w-sm">
        {/* Logo */}
        <div className="flex justify-center mb-8">
          <Link href="/" className="flex items-center gap-2.5">
            <Image
              src="/Mine Logo no background.png"
              alt="Mine"
              width={32}
              height={32}
              className="h-8 w-auto"
            />
            <span className="text-xl font-bold tracking-tight text-gray-900">Mine</span>
          </Link>
        </div>

        {/* Icon */}
        <div className="flex justify-center mb-5">
          <div className="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center">
            <svg
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-gray-400"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
              <line x1="11" y1="8" x2="11" y2="14" />
              <line x1="11" y1="16" x2="11.01" y2="16" />
            </svg>
          </div>
        </div>

        {/* Heading */}
        <h1 className="text-xl font-semibold text-gray-900 mb-2">
          Project not found
        </h1>

        {/* Description */}
        <p className="text-sm text-gray-500 leading-relaxed mb-8">
          This project doesn&apos;t exist or you don&apos;t have access to it.
          If you think this is a mistake, contact the project owner.
        </p>

        {/* Actions */}
        <div className="flex items-center justify-center gap-3">
          <Link
            href="/app/projects"
            className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium transition-colors"
          >
            ← Back to Projects
          </Link>
          <Link
            href="/"
            className="px-4 py-2 text-sm border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-100 font-medium transition-colors"
          >
            Go Home
          </Link>
        </div>
      </div>
    </div>
  )
}
