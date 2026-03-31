'use client'

import { useState } from 'react'
import Image from 'next/image'

interface ProductScreenshotProps {
  sourceSystem: string
  targetSystem: string
}

export default function ProductScreenshot({ sourceSystem, targetSystem }: ProductScreenshotProps) {
  const [imageError, setImageError] = useState(false)

  return (
    <div className="rounded-2xl overflow-hidden shadow-2xl border border-mine-slate-200">
      {/* Top bar */}
      <div className="h-9 bg-mine-slate-100 flex items-center px-3 gap-1.5 border-b border-mine-slate-200">
        <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
        <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
        <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
        <span className="text-mine-slate-400 text-xs ml-2">
          {sourceSystem} → {targetSystem} mapping
        </span>
      </div>

      {imageError ? (
        <div className="bg-mine-slate-50 p-8 flex items-center justify-center min-h-[200px]">
          <p className="text-mine-slate-400 text-sm text-center">
            Product preview — book a demo to see Mine in action
          </p>
        </div>
      ) : (
        <Image
          src="/images/product/mapping-review.png"
          alt={`Mine mapping review showing AI-generated field mappings with confidence scores for ${sourceSystem} to ${targetSystem} migration`}
          width={800}
          height={500}
          className="w-full h-auto"
          onError={() => setImageError(true)}
        />
      )}
    </div>
  )
}
