/**
 * Browser-side helpers for direct-to-Supabase-Storage uploads.
 *
 * Why this file exists
 * --------------------
 * Vercel's serverless function body limit is 4.5 MB and Next.js's default
 * `serverActions.bodySizeLimit` is 1 MB. Routing large file uploads through
 * server actions (via FormData multipart) fails before the application code
 * ever sees the body. The fix is direct-to-Storage: the server issues a
 * signed PUT URL for the user's path prefix in the `project-files` bucket,
 * the browser uploads the file directly to Supabase Storage, then a small
 * server action reads the file from Storage and runs the existing pipeline.
 *
 * Why XMLHttpRequest, not fetch
 * -----------------------------
 * `fetch` does not expose upload progress events. The streams-based
 * workaround (custom ReadableStream with a reader) is incompatible with
 * non-Chromium browsers as of 2026-01. XMLHttpRequest's `xhr.upload.progress`
 * event has been universally supported since 2012 and gives us
 * `{ loaded, total, lengthComputable }` for free.
 */

export interface UploadProgressEvent {
  loaded: number
  total: number
  lengthComputable: boolean
}

export interface UploadToSignedUrlOptions {
  /**
   * Fired on each upload progress tick. Use to drive a progress bar.
   * Fires only while bytes are flowing — not during the request setup
   * window or after the server response is received.
   */
  onProgress?: (event: UploadProgressEvent) => void
  /**
   * Content-Type header for the PUT. Defaults to `file.type`. Supabase
   * requires this to match what was declared at signed-URL-creation time
   * for some bucket configurations; the project-files bucket does not
   * enforce this, but we set it correctly anyway for downstream tooling
   * (e.g. the storage browser shows the right preview).
   */
  contentType?: string
  /**
   * Whether to overwrite an existing object at the same path. Defaults
   * to true — the upload-slot path is timestamped + dataset-scoped, so
   * collisions only happen on retry-of-same-attempt, where overwrite is
   * the right semantic.
   */
  upsert?: boolean
  /**
   * AbortSignal for cancelling the upload mid-flight. The returned
   * Promise rejects with the signal's reason on abort.
   */
  signal?: AbortSignal
}

/**
 * PUT a File to a Supabase Storage signed upload URL.
 *
 * Resolves on 2xx response, rejects on non-2xx, network error, or abort.
 */
export async function uploadToSignedUrl(
  url: string,
  file: File,
  options: UploadToSignedUrlOptions = {},
): Promise<void> {
  const {
    onProgress,
    contentType = file.type || 'application/octet-stream',
    upsert = true,
    signal,
  } = options

  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()

    if (onProgress) {
      xhr.upload.addEventListener('progress', (event) => {
        onProgress({
          loaded: event.loaded,
          total: event.total,
          lengthComputable: event.lengthComputable,
        })
      })
    }

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
      } else {
        reject(
          new Error(
            `Upload failed with status ${xhr.status}: ${xhr.statusText || 'unknown error'}`,
          ),
        )
      }
    })

    xhr.addEventListener('error', () => {
      reject(new Error('Upload failed: network error'))
    })

    xhr.addEventListener('abort', () => {
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error('Upload aborted'),
      )
    })

    if (signal) {
      if (signal.aborted) {
        reject(
          signal.reason instanceof Error ? signal.reason : new Error('Upload aborted'),
        )
        return
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }

    xhr.open('PUT', url, true)
    xhr.setRequestHeader('Content-Type', contentType)
    if (upsert) {
      xhr.setRequestHeader('x-upsert', 'true')
    }
    xhr.send(file)
  })
}
