import type * as chat from '../services/chat-service'
import type { AttachmentReference, AttachmentSource } from '../../shared/attachment-document'
import { sourceMessageId } from '../knowledge/message-identity'

/** Resolve provenance from the connected database, never from renderer-provided metadata. */
export async function resolveAttachmentSource(
  ref: AttachmentReference,
  dependencies: {
    resolveContact: typeof chat.resolveMd5
    listMessages: typeof chat.listMessagesAsync
  }
): Promise<AttachmentSource> {
  if (
    !ref ||
    typeof ref.conversationId !== 'string' ||
    typeof ref.messageId !== 'string' ||
    !Number.isFinite(ref.createTime) ||
    ref.createTime <= 0
  )
    throw new Error('附件消息引用无效')
  const contact = dependencies.resolveContact(ref.conversationId)
  if (!contact) throw new Error('找不到原始会话')
  const rows = await dependencies.listMessages(
    contact.md5,
    ref.createTime - 1,
    ref.createTime + 1,
    { limit: 2000 }
  )
  const message = rows.find(
    (item) => item.id === ref.messageId || sourceMessageId(item) === ref.messageId
  )
  const data = message?.contentData
  if (!message || data?.type !== 'share' || data.typeVal !== '6')
    throw new Error('找不到原始文件消息')
  if (!/\.(pdf|docx|xlsx)$/i.test(data.title)) throw new Error('仅支持 PDF、DOCX、XLSX 附件')
  return {
    conversationId: contact.md5,
    messageId: sourceMessageId(message),
    createTime: message.createTime || ref.createTime,
    fileName: data.title,
    sender: message.name || message.from,
    senderId: message.senderId
  }
}
