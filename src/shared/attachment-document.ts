import type { KnowledgeEvidence } from './knowledge'

export const DOCLING_VERSION = '2.142.0'
export const DOCLING_OCR_VERSION = '1.31.0'
export const ATTACHMENT_EXTENSIONS = ['pdf', 'docx', 'xlsx'] as const
export interface AttachmentReference {
  conversationId: string
  messageId: string
  /** Original message timestamp, Unix seconds; main verifies the actual message. */
  createTime: number
}
export interface AttachmentSource extends AttachmentReference {
  fileName: string
  sender: string
  senderId?: string
}
export interface AttachmentPart {
  location: string
  text: string
}
export interface AttachmentDocument {
  source: AttachmentSource
  parts: AttachmentPart[]
  parsedAt: number
  engine: string
}
export interface AttachmentStatus {
  state: 'unparsed' | 'parsing' | 'indexed' | 'stale' | 'failed'
  fileName?: string
  partCount?: number
  characters?: number
  error?: string
  cancelled?: boolean
}
export interface DoclingRuntimeStatus {
  ready: boolean
  version?: string
  preparing: boolean
  pdfReady: boolean
  error?: string
}
export interface AttachmentSearchResult {
  evidence: KnowledgeEvidence[]
}
export interface AttachmentReadResult {
  documents: AttachmentDocument[]
}

/** Query excerpts have a separate budget; report reads keep their complete-document contract. */
export interface AttachmentExcerptCoverage {
  totalCharacters: number
  includedCharacters: number
  truncated: boolean
}
export interface AttachmentExcerptRequest {
  conversationId: string
  references: Array<Pick<AttachmentReference, 'messageId' | 'createTime'>>
}
export interface AttachmentExcerptResult {
  documents: Array<AttachmentDocument & { coverage: AttachmentExcerptCoverage }>
}
