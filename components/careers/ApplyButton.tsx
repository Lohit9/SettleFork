import Link from 'next/link'

interface ApplyButtonProps {
  applyUrl: string
  label?: string
}

export default function ApplyButton({ applyUrl, label = 'Apply now' }: ApplyButtonProps) {
  return (
    <Link
      href={applyUrl}
      target='_blank'
      rel='noopener noreferrer'
      className='inline-flex items-center gap-2 bg-settle-blue-500 hover:bg-settle-blue-600 text-white font-medium px-8 py-4 rounded-lg transition-colors'
    >
      {label}
      <span aria-hidden='true'>→</span>
    </Link>
  )
}
