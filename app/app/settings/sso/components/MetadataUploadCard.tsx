'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Upload, AlertCircle } from '@/components/icons'
import { Loader2 } from 'lucide-react'
import {
  configureOrgSsoProviderFromUrl,
  configureOrgSsoProviderFromXml,
} from '@/lib/actions/sso-admin-provider-config'
import type { IdPType } from '@/lib/types/organizations'
import { ReplaceProviderDialog } from './ReplaceProviderDialog'

type Tab = 'xml' | 'url'
type UploadState =
  | { status: 'idle' }
  | { status: 'uploading' }
  | { status: 'error'; message: string }

interface CurrentProvider {
  idpType: IdPType | null
  entityId: string | null
  certFingerprintSha256: string | null
  certNotAfter: string | null
}

interface PendingReplace {
  source: { type: 'xml'; xml: string } | { type: 'url'; url: string }
  proposed: {
    idp_type: string
    entity_id: string
    cert_fingerprint_sha256: string
    cert_not_after: string
  }
}

export interface MetadataUploadCardProps {
  orgId: string
  orgSlug: string
  currentProvider: CurrentProvider | null
}

export function MetadataUploadCard(props: MetadataUploadCardProps) {
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('xml')
  const [uploadState, setUploadState] = useState<UploadState>({ status: 'idle' })
  const [urlInput, setUrlInput] = useState('')
  const [isDragOver, setIsDragOver] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const [pendingReplace, setPendingReplace] = useState<PendingReplace | null>(
    null,
  )
  const [replaceDialogError, setReplaceDialogError] = useState<string | null>(
    null,
  )

  async function handleFileSelected(file: File) {
    if (file.size > 5_000_000) {
      setUploadState({
        status: 'error',
        message: 'File is too large to upload.',
      })
      return
    }

    let xml: string
    try {
      xml = await file.text()
    } catch {
      setUploadState({ status: 'error', message: 'Failed to read file.' })
      return
    }

    await callConfigureXml(xml)
  }

  async function callConfigureXml(xml: string) {
    setUploadState({ status: 'uploading' })
    try {
      const result = await configureOrgSsoProviderFromXml(props.orgId, xml)
      handleConfigureResult(result, { type: 'xml', xml })
    } catch (err) {
      setUploadState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Upload failed.',
      })
    }
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) void handleFileSelected(file)
    e.target.value = ''
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) void handleFileSelected(file)
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setIsDragOver(true)
  }

  function handleDragLeave() {
    setIsDragOver(false)
  }

  async function handleFetchUrl(e: React.FormEvent) {
    e.preventDefault()
    if (!urlInput.trim()) return
    await callConfigureUrl(urlInput.trim())
  }

  async function callConfigureUrl(url: string) {
    setUploadState({ status: 'uploading' })
    try {
      const result = await configureOrgSsoProviderFromUrl(props.orgId, url)
      handleConfigureResult(result, { type: 'url', url })
    } catch (err) {
      setUploadState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Fetch failed.',
      })
    }
  }

  function handleConfigureResult(
    result: Awaited<ReturnType<typeof configureOrgSsoProviderFromXml>>,
    source: PendingReplace['source'],
  ) {
    if (result.ok) {
      setUploadState({ status: 'idle' })
      setUrlInput('')
      router.refresh()
      return
    }

    if (
      result.errorCode === 'ENTITY_ID_CHANGED' &&
      props.currentProvider?.entityId
    ) {
      const d = result.details
      setPendingReplace({
        source,
        proposed: {
          idp_type: d?.proposed_idp_type ?? 'generic',
          entity_id:
            d?.conflicting_entity_id ??
            '(Identity provider entity ID unavailable)',
          cert_fingerprint_sha256:
            d?.proposed_cert_fingerprint_sha256 ?? '',
          cert_not_after: d?.proposed_cert_not_after ?? '',
        },
      })
      setUploadState({ status: 'idle' })
      return
    }

    if (result.errorCode === 'ENTITY_ID_CHANGED') {
      setUploadState({
        status: 'error',
        message:
          result.error +
          ' Confirm replacement is unavailable until SSO is configured.',
      })
      return
    }

    if (result.errorCode === 'RATE_LIMITED' && result.details?.rate_limit_reset_at !== undefined) {
      const resetAt = result.details.rate_limit_reset_at
      const secondsUntilReset = Math.max(
        1,
        Math.ceil((resetAt - Date.now()) / 1000),
      )
      setUploadState({
        status: 'error',
        message: `${result.error} (retry in ${secondsUntilReset}s)`,
      })
      return
    }

    if (result.errorCode === 'PASSWORD_USERS_EXIST') {
      setUploadState({
        status: 'error',
        message: `${result.error} Contact support to override if intentional.`,
      })
      return
    }

    setUploadState({ status: 'error', message: result.error })
  }

  async function handleReplaceConfirm() {
    if (!pendingReplace) return
    setReplaceDialogError(null)

    const result =
      pendingReplace.source.type === 'xml'
        ? await configureOrgSsoProviderFromXml(
            props.orgId,
            pendingReplace.source.xml,
            { confirmReplaceEntityId: true },
          )
        : await configureOrgSsoProviderFromUrl(
            props.orgId,
            pendingReplace.source.url,
            { confirmReplaceEntityId: true },
          )

    if (result.ok) {
      setPendingReplace(null)
      setUploadState({ status: 'idle' })
      setUrlInput('')
      router.refresh()
    } else {
      setReplaceDialogError(result.error)
    }
  }

  const isUploading = uploadState.status === 'uploading'

  return (
    <section
      className="bg-white border border-gray-200 rounded-xl"
      data-testid="metadata-upload-card"
      data-org-slug={props.orgSlug}
    >
      <header className="px-5 py-3 border-b border-gray-200">
        <h2 className="text-sm font-semibold text-gray-900">
          {props.currentProvider?.entityId
            ? 'Update SSO provider'
            : 'Set up SSO provider'}
        </h2>
        <p className="text-xs text-gray-600 mt-0.5">
          Upload your IdP&apos;s SAML metadata XML or paste a metadata URL.
        </p>
      </header>

      <div className="px-5 py-4 space-y-4">
        <div
          role="tablist"
          aria-label="Metadata source"
          className="inline-flex rounded-md border border-gray-200 bg-gray-50 p-0.5"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'xml'}
            onClick={() => setTab('xml')}
            className={
              tab === 'xml'
                ? 'bg-white text-gray-900 shadow-sm rounded px-3 py-1 text-sm font-medium'
                : 'text-gray-600 px-3 py-1 text-sm hover:text-gray-900'
            }
            data-testid="metadata-upload-tab-xml"
          >
            Upload XML
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'url'}
            onClick={() => setTab('url')}
            className={
              tab === 'url'
                ? 'bg-white text-gray-900 shadow-sm rounded px-3 py-1 text-sm font-medium'
                : 'text-gray-600 px-3 py-1 text-sm hover:text-gray-900'
            }
            data-testid="metadata-upload-tab-url"
          >
            Paste URL
          </button>
        </div>

        {tab === 'xml' ? (
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xml,text/xml,application/xml,application/samlmetadata+xml"
              className="hidden"
              onChange={handleInputChange}
              disabled={isUploading}
              data-testid="metadata-upload-file-input"
            />
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              className={`border-[1.5px] border-dashed rounded-lg p-6 text-center transition-colors ${
                isDragOver
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-300 hover:border-gray-400'
              }`}
              data-testid="metadata-upload-drop-zone"
            >
              {isUploading ? (
                <div className="flex items-center justify-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-gray-500" />
                  <span className="text-sm text-gray-600">
                    Validating metadata…
                  </span>
                </div>
              ) : (
                <>
                  <Upload className="w-8 h-8 text-gray-400 mx-auto mb-2" />
                  <p className="text-sm text-gray-700 mb-1">
                    Drop XML file here or click to select
                  </p>
                  <p className="text-xs text-gray-500 mb-3">Max 1 MB</p>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    data-testid="metadata-upload-select-file"
                  >
                    Select file
                  </button>
                </>
              )}
            </div>
          </div>
        ) : null}

        {tab === 'url' ? (
          <form onSubmit={handleFetchUrl} className="space-y-2">
            <label htmlFor="metadata-url" className="block text-sm text-gray-700">
              Metadata URL
            </label>
            <div className="flex gap-2">
              <input
                id="metadata-url"
                type="url"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://login.example.com/saml/metadata"
                autoComplete="off"
                spellCheck={false}
                disabled={isUploading}
                className="flex-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-mono text-gray-900 placeholder-gray-400 focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:bg-gray-50"
                data-testid="metadata-upload-url-input"
              />
              <button
                type="submit"
                disabled={isUploading || !urlInput.trim()}
                className="inline-flex items-center justify-center rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:bg-gray-400 disabled:cursor-not-allowed"
                data-testid="metadata-upload-fetch-button"
              >
                {isUploading ? 'Fetching…' : 'Fetch & validate'}
              </button>
            </div>
            <p className="text-xs text-gray-500">
              Must be a public HTTPS URL. We&apos;ll fetch and validate the
              metadata server-side.
            </p>
          </form>
        ) : null}

        {uploadState.status === 'error' ? (
          <div
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 flex items-start gap-2"
            role="alert"
            data-testid="metadata-upload-error"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{uploadState.message}</span>
          </div>
        ) : null}
      </div>

      {pendingReplace && props.currentProvider?.entityId ? (
        <ReplaceProviderDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setPendingReplace(null)
              setReplaceDialogError(null)
            }
          }}
          orgSlug={props.orgSlug}
          current={{
            idp_type:
              props.currentProvider.idpType ?? 'generic',
            entity_id: props.currentProvider.entityId,
            cert_fingerprint_sha256:
              props.currentProvider.certFingerprintSha256,
            cert_not_after: props.currentProvider.certNotAfter,
          }}
          proposed={pendingReplace.proposed}
          onConfirm={handleReplaceConfirm}
          errorMessage={replaceDialogError}
        />
      ) : null}
    </section>
  )
}
