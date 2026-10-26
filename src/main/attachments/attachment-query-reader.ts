import type { FormattedMessage } from '../services/chat-service'
import { sourceMessageId } from '../knowledge/message-identity'
import type { QueryMessage } from '../../shared/local-query-api'
import type {
  AttachmentExcerptRequest,
  AttachmentExcerptResult
} from '../../shared/attachment-document'

export type AttachmentExcerptReader = (
  request: AttachmentExcerptRequest
) => Promise<AttachmentExcerptResult>

/** Only enrich already selected source messages. Never scans files, starts parsing or calls a model. */
export async function enrichAttachmentMessages(
  conversationId: string,
  originals: FormattedMessage[],
  messages: QueryMessage[],
  reader?: AttachmentExcerptReader
): Promise<QueryMessage[]> {
  const files = originals.filter((_, i) => messages[i].sourceKind === 'file')
  if (!files.length) return messages
  const supported = (message: FormattedMessage): boolean => {
    const data = message.contentData
    const name = data?.type === 'share' ? data.title : message.exportMediaName
    return /\.(pdf|docx|xlsx)$/i.test(name || '')
  }
  const references = files.filter(supported).map((message) => ({
    messageId: sourceMessageId(message),
    createTime: message.createTime || 0
  }))
  const result =
    reader && references.length ? await reader({ conversationId, references }) : { documents: [] }
  const documents = new Map(
    result.documents
      .filter((doc) => doc.source.conversationId === conversationId)
      .map((doc) => [doc.source.messageId, doc])
  )
  return messages.map((message, i) => {
    if (message.sourceKind !== 'file') return message
    const source = originals[i]
    if (!supported(source)) return { ...message, attachmentTextState: 'unsupported' }
    const document = documents.get(sourceMessageId(source))
    if (!document || document.source.createTime !== source.createTime)
      return { ...message, attachmentTextState: 'not_available' }
    const coverage = document.coverage
    if (!coverage.includedCharacters)
      return {
        ...message,
        attachmentTextState: 'budget_exceeded',
        attachmentTextCoverage: coverage
      }
    const note = coverage.truncated
      ? `仅提供正文前 ${coverage.includedCharacters}/${coverage.totalCharacters} 字符，不能据此宣称已总结全文；可按关键词检索或用附件日报分段总结。`
      : `已提供本地解析正文 ${coverage.totalCharacters} 字符，解析结果仍需核对原件。`
    return {
      ...message,
      derivedSource: 'attachment_text',
      attachmentTextState: 'indexed',
      attachmentTextCoverage: coverage,
      attachmentText:
        `附件《${document.source.fileName}》（本地解析正文，非群成员发言）\n${note}\n` +
        document.parts.map((part) => `[${part.location}]\n${part.text}`).join('\n')
    }
  })
}
