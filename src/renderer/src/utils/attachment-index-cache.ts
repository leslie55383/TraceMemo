import type { AISearchCacheRecord } from '../components/search/searchTypes'

const REVISION_KEY = 'wxe_attachment_index_changed_at'
export function markAttachmentIndexChanged(): void {
  localStorage.setItem(
    REVISION_KEY,
    String(Math.max(Date.now(), Number(localStorage.getItem(REVISION_KEY) || 0) + 1))
  )
}

/** Keep historical answers, but re-query after a mutation or to recheck a file's freshness. */
export function canReuseAttachmentSearchCache(record: AISearchCacheRecord): boolean {
  if (record.createdAt <= Number(localStorage.getItem(REVISION_KEY) || 0)) return false
  return ![...(record.evidence || []), ...(record.evidenceCollection || [])].some(
    (item) => item.derivedSource === 'attachment_text'
  )
}
