import type { Contact, Message } from '../../../shared/types'
import type { ReportMediaApi } from './group-report-facts'
import { getReportImageInputs } from './group-report-facts'
import type { ReportImageSelectionMode } from '../../../shared/image-insight'
import { isHotImageCandidate } from '../../../shared/image-insight'

export interface ReportImagePreview {
  id: string
  sender: string
  time: string
  url?: string
  error?: string
  selected: boolean
  reason: string
}
export async function loadReportImagePreviews(
  messages: Message[],
  contact: Contact | null,
  limit: number,
  mode: ReportImageSelectionMode,
  api: ReportMediaApi,
  page = 0
): Promise<{ images: ReportImagePreview[]; selectedIds: string[]; total: number }> {
  const inputs = getReportImageInputs(messages, contact, true)
  const result = await api.imageListCandidates({
    sessionId: inputs[0]?.sessionId || '',
    startTime: 0,
    endTime: Date.now(),
    limit,
    selectionMode: mode,
    inputs
  })
  if (!result.success) throw new Error(result.error || '筛选图片失败')
  const selected = new Set(result.candidates.map((item) => item.messageId))
  const previews: ReportImagePreview[] = []
  const pageInputs = inputs.slice(page * 24, (page + 1) * 24)
  for (let offset = 0; offset < pageInputs.length; offset += 3) {
    previews.push(
      ...(await Promise.all(
        pageInputs.slice(offset, offset + 3).map(async (input) => {
          let image: { success: boolean; data?: string; error?: string }
          try {
            image = await api.getImage(input.md5, input.datName, input.sessionId, {
              includeData: true
            })
          } catch (error) {
            image = {
              success: false,
              error: error instanceof Error ? error.message : String(error)
            }
          }
          return {
            id: input.messageId,
            sender: input.sender,
            time: new Date(input.sentAt).toLocaleString('zh-CN'),
            url: image.data,
            error: image.success ? undefined : image.error || '图片不可用',
            selected: selected.has(input.messageId),
            reason: selected.has(input.messageId)
              ? isHotImageCandidate(input)
                ? '热点入选'
                : '普通图片补入'
              : isHotImageCandidate(input)
                ? '受数量上限或重复合并影响'
                : '普通图片，可手动选择'
          }
        })
      ))
    )
  }
  return { images: previews, selectedIds: [...selected], total: inputs.length }
}
