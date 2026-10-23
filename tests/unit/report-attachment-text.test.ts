import { describe, expect, it, vi } from 'vitest'
import { buildGroupReportInput } from '../../src/renderer/src/utils/group-report'
import {
  buildGroupReportFacts,
  type ReportMediaApi
} from '../../src/renderer/src/utils/group-report-facts'
import type { Contact, Message } from '../../src/shared/types'

const contact: Contact = {
  md5: 'fixture-group',
  m_nsUsrName: 'fixture@chatroom',
  m_nsNickName: '测试群',
  type: 'group'
}
const file: Message = {
  id: 'raw-file',
  localId: 7,
  from: 'member',
  name: '测试成员',
  datetime: '2026-10-22 10:00:00',
  isSender: false,
  type: '文件',
  content: '[文件]计划.xlsx',
  contentData: { type: 'share', typeVal: '6', title: '计划.xlsx', url: '' }
}
const api = () =>
  ({
    imageListCandidates: vi.fn(),
    imageAnalyze: vi.fn(),
    getImage: vi.fn(),
    attachmentReadDocuments: vi.fn(async () => ({
      documents: [
        {
          source: {
            conversationId: 'fixture-group',
            messageId: 'local:7',
            createTime: 100,
            fileName: '计划.xlsx',
            sender: '测试成员'
          },
          parts: [
            { location: '工作表：预算', text: '研发预算为24680元' },
            { location: '工作表：排期', text: '十一月验收' }
          ],
          parsedAt: 1,
          engine: 'test'
        }
      ]
    }))
  }) satisfies ReportMediaApi

describe('report attachment input', () => {
  it('includes local bodies with provenance while retaining original message IDs and counts', async () => {
    const runtime = api()
    const facts = await buildGroupReportFacts([file], contact, true, 'full', { imageApi: runtime })
    expect(runtime.attachmentReadDocuments).toHaveBeenCalledWith({
      conversationId: 'fixture-group',
      messageIds: ['local:7']
    })
    expect(facts.transcriptRows[0]).toMatchObject({ id: 'raw-file', sender: '测试成员' })
    expect(facts.transcriptRows[0].content).toContain('工作表：预算')
    expect(facts.transcriptRows[0].content).toContain('24680')
    expect(facts.metadata.messageCount).toBe(1)
    expect(facts.metadata.recordNote).toContain('1/1 份')
    const input = await buildGroupReportInput([file], contact, true, 'full', { imageApi: runtime })
    expect(input.prompt).toContain('十一月验收')
    expect(input.prompt).toContain('附件正文覆盖：1/1')
    expect(JSON.stringify(input.summarySource)).toContain('24680')
    expect(runtime.imageAnalyze).not.toHaveBeenCalled()
    expect(file.content).toBe('[文件]计划.xlsx')
  })
  it('honestly reports unparsed attachments and propagates database errors', async () => {
    const runtime = api()
    runtime.attachmentReadDocuments.mockResolvedValueOnce({ documents: [] })
    const facts = await buildGroupReportFacts([file], contact, true, 'full', { imageApi: runtime })
    expect(facts.metadata.recordNote).toContain('0/1 份')
    expect(facts.transcriptRows[0].content).not.toContain('附件正文开始')
    runtime.attachmentReadDocuments.mockRejectedValueOnce(new Error('索引读取失败'))
    await expect(
      buildGroupReportFacts([file], contact, true, 'full', { imageApi: runtime })
    ).rejects.toThrow('索引读取失败')
  })
})
