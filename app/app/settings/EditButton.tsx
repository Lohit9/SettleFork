'use client'

export function EditButton() {
  return (
    <button
      onClick={() => alert('Profile editing coming soon.')}
      className="text-sm text-gray-500 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 transition-colors flex-shrink-0"
    >
      Edit
    </button>
  )
}
