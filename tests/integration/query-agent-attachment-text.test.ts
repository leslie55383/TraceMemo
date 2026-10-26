import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentExcerptResult } from '../../src/shared/attachment-document'

const fixture = vi.hoisted(() => ({
  contacts: [
    {
      md5: 'group-a',
      m_nsUsrName: 'group@chatroom',
      m_nsNickName: '项目群',
      type: 'group' as const
    }
  ],
  messages: [
    {
      id: 'raw-file',
      localId: 7,
      from: 'user',
      name: '测试成员',
      isSender: false,
      type: '文件',
      datetime: '2026-10-26 10:00:00',
      createTime: 100,
      content: '[文件]预算.pdf',
      contentData: { type: 'share' as const, typeVal: '6', title: '预算.pdf', url: '' }
    }
  ]
}))
vi.mock('../../src/main/services/chat-service', () => ({
  isReady: () => true,
  listContactsAsync: vi.fn(async () => fixture.contacts),
  listMessagesAsync: vi.fn(async () => fixture.messages)
}))
import { LocalQueryApiService } from '../../src/main/services/local-query-api-service'
import { listMessagesAsync } from '../../src/main/services/chat-service'
import { createLocalQueryToolExecutor } from '../../src/main/services/local-query-tool-executor'
import {
  QueryAgentService,
  type QueryAgentProvider
} from '../../src/main/services/query-agent-service'
import {
  decodeMessageRef,
  encodeMessageRef,
  type QueryMessagesResponse,
  type QueryMessagesRequest,
  type MessageContextResponse,
  type MessageContextRequest,
  type ConversationOverviewResponse
} from '../../src/shared/local-query-api'

const document = (): AttachmentExcerptResult['documents'][number] => ({
  source: {
    conversationId: 'group-a',
    messageId: 'local:7',
    createTime: 100,
    fileName: '预算.pdf',
    sender: '测试成员'
  },
  parts: [{ location: '第 2 页', text: '研发预算为24680元。' }],
  parsedAt: 1,
  engine: 'fixture',
  coverage: { totalCharacters: 12, includedCharacters: 12, truncated: false }
})
const request = {
  target: { query: '项目群' },
  timeRange: { kind: 'all' as const },
  messageTypes: ['file' as const]
}
function setup(docs = [document()]) {
  const reader = vi.fn(async (): Promise<AttachmentExcerptResult> => ({ documents: docs }))
  const service = new LocalQueryApiService(undefined, () => new Date('2026-10-26T12:00:00+08:00'))
  service.setAttachmentExcerptReader(reader)
  return { service, reader }
}

// Successful-response projections keep legacy inferred error variants out of these assertions.
const readMessages = (
  service: LocalQueryApiService,
  input: QueryMessagesRequest = request
): Promise<QueryMessagesResponse> => service.messages(input) as Promise<QueryMessagesResponse>
const readContext = (
  service: LocalQueryApiService,
  input: MessageContextRequest
): Promise<MessageContextResponse> => service.context(input) as Promise<MessageContextResponse>

describe('attachment text across precise reads, context and Query Agent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listMessagesAsync).mockReset().mockResolvedValue(fixture.messages)
  })
  it('gives context anchors first priority without changing the before/after message order', async () => {
    const original = fixture.messages[0]
    vi.mocked(listMessagesAsync).mockResolvedValueOnce([
      { ...original, id: 'older', localId: 8, createTime: 50 },
      original,
      { ...original, id: 'newer', localId: 9, createTime: 150 }
    ])
    const { service, reader } = setup()
    const result = await readContext(service, {
      messageRef: encodeMessageRef('group-a', '7'),
      before: 1,
      after: 1
    })
    expect(reader).toHaveBeenCalledWith({
      conversationId: 'group-a',
      references: [
        { messageId: 'local:7', createTime: 100 },
        { messageId: 'local:8', createTime: 50 },
        { messageId: 'local:9', createTime: 150 }
      ]
    })
    expect(decodeMessageRef(result.before![0].messageRef)?.messageId).toBe('8')
    expect(decodeMessageRef(result.after![0].messageRef)?.messageId).toBe('9')
    expect(result.anchor?.attachmentText).toContain('24680')
  })
  it('does not request bodies for unsupported formats and propagates index read failures', async () => {
    const { service, reader } = setup()
    vi.mocked(listMessagesAsync).mockResolvedValueOnce([
      {
        ...fixture.messages[0],
        contentData: { ...fixture.messages[0].contentData, title: 'archive.zip' }
      }
    ])
    expect((await readMessages(service)).messages![0].attachmentTextState).toBe('unsupported')
    expect(reader).not.toHaveBeenCalled()
    reader.mockRejectedValueOnce(new Error('附件正文索引读取失败'))
    await expect(readMessages(service)).rejects.toThrow('附件正文索引读取失败')
  })
  it('preserves original message text, uses canonical refs, and reads only selected files in one batch', async () => {
    const { service, reader } = setup()
    const result = await readMessages(service)
    expect(reader).toHaveBeenCalledWith({
      conversationId: 'group-a',
      references: [{ messageId: 'local:7', createTime: 100 }]
    })
    const message = result.messages![0]
    expect(message.text).toBe('[文件]预算.pdf')
    expect(message.attachmentText).toContain('第 2 页')
    expect(message.attachmentText).toContain('24680')
    expect(message.derivedSource).toBe('attachment_text')
    expect(message.attachmentTextState).toBe('indexed')
    expect(decodeMessageRef(message.messageRef)).toEqual({
      conversationId: 'group-a',
      messageId: '7'
    })
    expect(fixture.messages[0].content).toBe('[文件]预算.pdf')
    await readMessages(service, { ...request, messageTypes: ['text'] })
    expect(reader).toHaveBeenCalledTimes(1)
  })
  it('reads context for refs from attachment search and accepts old raw refs without changing identity', async () => {
    const { service } = setup()
    for (const id of ['local:7', 'raw-file']) {
      const result = await readContext(service, {
        messageRef: encodeMessageRef('group-a', id),
        before: 0,
        after: 0
      })
      expect(result.anchor?.attachmentText).toContain('24680')
      expect(decodeMessageRef(result.anchor!.messageRef)?.messageId).toBe('7')
      expect(result.before).toEqual([])
    }
  })
  it('keeps truncated and unavailable content distinct from a known-empty file', async () => {
    const doc = document()
    doc.coverage = { includedCharacters: 12, totalCharacters: 100000, truncated: true }
    const { service, reader } = setup([doc])
    let result = await readMessages(service)
    expect(result.messages![0].attachmentText).toContain('不能据此宣称已总结全文')
    expect(result.messages![0].attachmentTextCoverage?.truncated).toBe(true)
    reader.mockResolvedValueOnce({ documents: [] })
    result = await readMessages(service)
    expect(result.messages![0]).toMatchObject({ attachmentTextState: 'not_available' })
    expect(result.messages![0].attachmentText).toBeUndefined()
    reader.mockResolvedValueOnce({
      documents: [{ ...doc, parts: [], coverage: { ...doc.coverage, includedCharacters: 0 } }]
    })
    result = await readMessages(service)
    expect(result.messages![0].attachmentTextState).toBe('budget_exceeded')
    expect(result.messages![0].derivedSource).toBeUndefined()
  })
  it('rejects mismatched bindings and out-of-scope reads before returning file bodies', async () => {
    const { service, reader } = setup([
      { ...document(), source: { ...document().source, createTime: 101 } }
    ])
    expect((await readMessages(service)).messages![0].attachmentTextState).toBe('not_available')
    reader.mockResolvedValueOnce({
      documents: [{ ...document(), source: { ...document().source, conversationId: 'other' } }]
    })
    expect((await readMessages(service)).messages![0].attachmentTextState).toBe('not_available')
    reader.mockClear()
    await readContext(service, {
      messageRef: encodeMessageRef('other', '7'),
      scope: { kind: 'current', conversationId: 'group-a' }
    })
    expect(reader).not.toHaveBeenCalled()
  })
  it('enriches only the overview representatives while retaining chat counts and sampling coverage', async () => {
    const { service } = setup()
    const result = (await service.overview({
      target: request.target,
      timeRange: request.timeRange
    })) as ConversationOverviewResponse
    expect(result.evidence![0]).toMatchObject({
      derivedSource: 'attachment_text',
      text: expect.stringContaining('24680')
    })
    expect(result.evidence![0].attachmentTextCoverage?.truncated).toBe(false)
    expect(result.sourceMessageCount).toBe(1)
    expect(result.evidenceCount).toBe(1)
  })
  it('keeps file citations and body provenance all the way from the tool to final evidence', async () => {
    const { service } = setup()
    const responses = [
      {
        success: true,
        toolCalls: [
          {
            id: 'c1',
            name: 'query_messages',
            arguments: JSON.stringify({ ...request, temporalBasis: { kind: 'none' } })
          }
        ]
      },
      { success: true, data: '附件《预算.pdf》第2页写明研发预算为24680元。[E1]' }
    ]
    const provider: QueryAgentProvider = {
      getRuntimeConfig: () => ({
        configured: true,
        providerName: 'Fixture',
        model: 'fixture',
        modelName: 'Fixture'
      }),
      chatWithTools: vi.fn(async () => responses.shift() || { success: true, data: 'done' })
    }
    const result = await new QueryAgentService(provider, createLocalQueryToolExecutor(service)).run(
      '项目群最近那份 PDF 写了什么？'
    )
    const calls = vi.mocked(provider.chatWithTools).mock.calls
    const tool = JSON.parse(String(calls[1][0].find((message) => message.role === 'tool')?.content))
    expect(tool.messages[0].attachmentText).toContain('24680')
    expect(tool.messages[0].citationId).toBe('E1')
    expect(result.evidence).toHaveLength(1)
    expect(result.evidence![0]).toMatchObject({
      derivedSource: 'attachment_text',
      messageType: 'file',
      citationId: 'E1',
      text: expect.stringContaining('第 2 页')
    })
    expect(decodeMessageRef(result.evidence![0].messageRef)).toEqual({
      conversationId: 'group-a',
      messageId: '7'
    })
    expect(String(calls[0][0][0].content)).toContain('attachmentTextCoverage.truncated=true')
  })
  it('upgrades a file metadata citation with later context body while retaining the original citation number', async () => {
    const { service } = setup()
    const responses = [
      {
        success: true,
        toolCalls: [
          {
            id: 'c1',
            name: 'search_messages',
            arguments: JSON.stringify({ queries: ['预算'], timeRange: { kind: 'all' } })
          }
        ]
      },
      {
        success: true,
        toolCalls: [
          {
            id: 'c2',
            name: 'message_context',
            arguments: JSON.stringify({
              messageRef: encodeMessageRef('group-a', '7'),
              before: 0,
              after: 0
            })
          }
        ]
      },
      { success: true, data: '这份附件的研发预算为24680元。[E1]' }
    ]
    const provider: QueryAgentProvider = {
      getRuntimeConfig: () => ({
        configured: true,
        providerName: 'Fixture',
        model: 'fixture',
        modelName: 'Fixture'
      }),
      chatWithTools: vi.fn(async () => responses.shift() || { success: true, data: 'done' })
    }
    const executor = createLocalQueryToolExecutor(service)
    const result = await new QueryAgentService(provider, async (name, input, context) =>
      name === 'search_messages'
        ? {
            status: 'completed',
            evidence: [
              {
                messageRef: encodeMessageRef('group-a', '7'),
                sourceKind: 'file',
                text: '[文件]预算.pdf'
              }
            ]
          }
        : executor(name, input, context)
    ).run('请结合原消息看看这份文件写了什么')
    expect(result.evidence).toHaveLength(1)
    expect(result.evidence![0]).toMatchObject({
      citationId: 'E1',
      source: 'search_messages',
      derivedSource: 'attachment_text',
      text: expect.stringContaining('24680')
    })
  })
})
