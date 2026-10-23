import { describe, expect, it, vi } from 'vitest'
import { resolveAttachmentSource } from '../../src/main/attachments/attachment-source'
import type { FormattedMessage } from '../../src/main/services/chat-service'

const message: FormattedMessage = {
  id: 'raw-id',
  localId: 7,
  createTime: 100,
  datetime: 'fixture',
  from: 'user',
  type: '文件',
  name: '真实发送者',
  senderId: 'trusted-sender',
  content: '[文件]',
  isSender: false,
  contentData: { type: 'share', typeVal: '6', title: '原附件.pdf', url: '' }
}
const contact = {
  md5: 'canonical-group',
  m_nsUsrName: 'group@chatroom',
  m_nsNickName: '测试群',
  type: 'group' as const
}
const ref = { conversationId: 'group@chatroom', messageId: 'raw-id', createTime: 100 }
describe('attachment source verification', () => {
  it('uses the real file metadata and canonical identity, accepting stable or raw message IDs', async () => {
    const dependencies = {
      resolveContact: vi.fn(() => contact),
      listMessages: vi.fn(async () => [message])
    }
    for (const messageId of ['raw-id', 'local:7']) {
      const result = await resolveAttachmentSource(
        { ...ref, messageId, fileName: 'forged.pdf' } as typeof ref,
        dependencies
      )
      expect(result).toMatchObject({
        conversationId: 'canonical-group',
        messageId: 'local:7',
        fileName: '原附件.pdf',
        sender: '真实发送者'
      })
    }
    expect(dependencies.listMessages).toHaveBeenCalledWith('canonical-group', 99, 101, {
      limit: 2000
    })
  })
  it('rejects missing messages, links masquerading as attachments, and invalid timestamps', async () => {
    const dependencies = {
      resolveContact: () => contact,
      listMessages: vi.fn(async () => [message])
    }
    await expect(
      resolveAttachmentSource({ ...ref, messageId: 'other-id' }, dependencies)
    ).rejects.toThrow('原始文件消息')
    dependencies.listMessages.mockResolvedValueOnce([
      { ...message, contentData: { type: 'share', typeVal: '5', title: 'link.pdf', url: '' } }
    ])
    await expect(resolveAttachmentSource(ref, dependencies)).rejects.toThrow('原始文件消息')
    await expect(
      resolveAttachmentSource({ ...ref, createTime: NaN }, dependencies)
    ).rejects.toThrow('引用无效')
  })
})
