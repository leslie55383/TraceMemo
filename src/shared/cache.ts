export type CacheClearScope =
  | 'bootstrap'
  | 'electron'
  | 'knowledge'
  | 'image-text-index'
  | 'attachment-text'
  | 'all'

export interface CacheSummaryItem {
  id: 'bootstrap' | 'electron' | 'knowledge' | 'image-text-index' | 'attachment-text'
  label: string
  description: string
  sizeBytes: number
  fileCount: number
}

export interface CacheSummary {
  items: CacheSummaryItem[]
  totalBytes: number
  updatedAt: number
}
