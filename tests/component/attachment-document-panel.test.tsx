import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentDocumentPanel } from '../../src/renderer/src/components/chat/AttachmentDocumentPanel'
import type { Contact, Message } from '../../src/shared/types'

const contact: Contact = {
  md5: 'group',
  m_nsUsrName: 'test@chatroom',
  m_nsNickName: '测试群',
  type: 'group'
}
const message: Message = {
  id: 'raw-file',
  localId: 7,
  createTime: 100,
  from: 'user',
  type: '文件',
  content: '[文件]',
  isSender: false,
  datetime: '2026-10-22 10:00:00',
  contentData: { type: 'share', typeVal: '6', title: '预算.xlsx', url: '' }
}
const api = {
  attachmentRuntimeStatus: vi.fn(),
  attachmentStatus: vi.fn(),
  attachmentPrepareRuntime: vi.fn(),
  attachmentParse: vi.fn(),
  attachmentCancel: vi.fn(),
  attachmentRemove: vi.fn()
}
describe('attachment document panel', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    Object.defineProperty(window, 'api', { configurable: true, value: api })
    api.attachmentRuntimeStatus.mockResolvedValue({ ready: true, pdfReady: true, preparing: false })
    api.attachmentStatus.mockResolvedValue({ state: 'unparsed' })
  })
  it('loads only on expansion, parses explicitly, explains model sharing, and removes derived text', async () => {
    api.attachmentParse.mockResolvedValue({ state: 'indexed', partCount: 2 })
    api.attachmentRemove.mockResolvedValue({ state: 'unparsed' })
    render(<AttachmentDocumentPanel message={message} contact={contact} />)
    expect(api.attachmentStatus).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /附件正文/ }))
    expect(await screen.findByText(/命中的正文会发送/)).toBeVisible()
    const parse = screen.getByRole('button', { name: '选择本地附件并解析' })
    await waitFor(() => expect(parse).toBeEnabled())
    fireEvent.click(parse)
    expect(await screen.findByText(/正文已加入搜索和日报/)).toBeVisible()
    expect(api.attachmentParse).toHaveBeenCalledWith({
      conversationId: 'group',
      messageId: 'raw-file',
      createTime: 100
    })
    fireEvent.click(screen.getByRole('button', { name: '删除正文索引' }))
    expect(await screen.findByText('尚未解析')).toBeVisible()
  })
  it('offers environment preparation and supports retry after errors', async () => {
    api.attachmentRuntimeStatus.mockResolvedValue({
      ready: false,
      pdfReady: false,
      preparing: false
    })
    api.attachmentPrepareRuntime.mockResolvedValue({
      ready: true,
      pdfReady: true,
      preparing: false
    })
    api.attachmentParse.mockResolvedValue({ state: 'failed', error: '文件损坏' })
    render(<AttachmentDocumentPanel message={message} contact={contact} />)
    fireEvent.click(screen.getByRole('button', { name: /附件正文/ }))
    fireEvent.click(await screen.findByRole('button', { name: '准备本地解析环境' }))
    const parse = screen.getByRole('button', { name: '选择本地附件并解析' })
    await waitFor(() => expect(parse).toBeEnabled())
    fireEvent.click(parse)
    expect(await screen.findByRole('alert')).toHaveTextContent('文件损坏')
    expect(parse).toBeEnabled()
  })
  it('does not expose parsing for links or unsupported old office files', () => {
    render(
      <AttachmentDocumentPanel
        message={{
          ...message,
          contentData: { type: 'share', typeVal: '5', title: '链接.pdf', url: '' }
        }}
        contact={contact}
      />
    )
    expect(screen.queryByRole('button')).toBeNull()
  })
})
