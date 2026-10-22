import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeReportPreferences } from '../../src/shared/report-preferences'
import type { ReportMediaApi } from '../../src/renderer/src/utils/group-report-facts'
import type { Message, Contact } from '../../src/shared/types'

const mocks = vi.hoisted(() => ({ chat: vi.fn(), export: vi.fn() }))
vi.mock('../../src/main/services/ai-provider-service', () => ({
  AIProviderService: class {
    getRuntimeConfig() {
      return { providerName: 'fixture', model: 'fixture-text' }
    }
    chat = mocks.chat
  }
}))
vi.mock('../../src/main/services/report-preferences-service', () => ({
  loadReportPreferences: () =>
    normalizeReportPreferences({
      imageLimit: 8,
      imageSelectionMode: 'hot-first',
      imageMethod: 'ocr-only'
    })
}))
vi.mock('../../src/main/group-report-service', () => ({ exportGroupReport: mocks.export }))
vi.mock('../../src/main/services/chat-service', () => ({
  resolveMd5: () => contact,
  listMessages: () => messages,
  getGroupSnapshot: () => null
}))

import { generateAgentGroupReport } from '../../src/main/services/agent-group-report-service'
import { bindReportMediaRuntime } from '../../src/main/services/report-media-runtime'
import { buildGroupReportInput } from '../../src/renderer/src/utils/group-report'
import { normalizeScheduledReportConfig } from '../../src/shared/automation'
import { prepareLongReportInput } from '../../src/shared/report-long-record'
import { GROUP_REPORT_SYSTEM_PROMPT } from '../../src/renderer/src/utils/group-report'

const contact: Contact = {
  md5: 'fixture-group-md5',
  m_nsUsrName: 'fixture-group@chatroom',
  m_nsNickName: '示例群',
  type: 'group'
}
const messages: Message[] = [0, 1, 2, 3].map((index) => ({
  id: `fixture-image-${index}`,
  from: 'fixture-member',
  name: '示例成员',
  type: '图片',
  content: '[图片]',
  datetime: `2026-10-01 10:0${index}:00`,
  isSender: false,
  sessionId: contact.m_nsUsrName,
  contentData: { type: 'image', md5: String(index).repeat(32) }
}))
const originalMessages = structuredClone(messages)
const runtime: ReportMediaApi = {
  imageListCandidates: async (query) => ({
    success: true,
    candidates: (query.inputs || [])
      .slice(0, query.limit)
      .map((input) => ({ ...input, imageHash: input.md5!, heatScore: 1 }))
  }),
  imageAnalyze: vi.fn(async () => ({ success: false, error: 'must not call remote vision' })),
  getImage: async () => ({ success: true, data: 'data:image/png;base64,fixture' }),
  recognizeLocalImageText: async (request) => ({
    success: true,
    text: `fixture-公告-${request.imageHash}`,
    lines: [],
    language: 'zh-Hans-CN',
    engine: 'windows-system-ocr',
    durationMs: 1
  })
}

describe('manual, Agent and scheduled report preparation', () => {
  beforeEach(() => {
    messages.splice(0, messages.length, ...structuredClone(originalMessages))
    bindReportMediaRuntime(runtime)
    mocks.chat.mockResolvedValue({
      success: true,
      data: JSON.stringify({
        overview: 'fixture-summary',
        topics: [{ title: 'fixture-topic', summary: 'fixture-summary', heat: '高', keywords: [] }]
      })
    })
    mocks.export.mockResolvedValue({
      success: true,
      pngPath: 'fixture-report.png',
      htmlPath: 'fixture-report.html'
    })
  })
  it('uses the same OCR input and rule overrides for background generation as manual generation', async () => {
    const preferences = normalizeReportPreferences({
      imageLimit: 4,
      imageSelectionMode: 'hot-first',
      imageMethod: 'ocr-only',
      density: 'detailed',
      textModel: { providerId: 'fixture-other', model: 'fixture-selected-text' }
    })
    const manual = await buildGroupReportInput(messages, contact, true, 'full', {
      imageApi: runtime,
      imageLimit: 4,
      imageSelectionMode: 'hot-first',
      imageMethod: 'ocr-only',
      preferences
    })
    const config = normalizeScheduledReportConfig({
      report: { sourceConversationId: contact.m_nsUsrName, preferences }
    })
    const generated = await generateAgentGroupReport({
      group: contact.m_nsUsrName,
      messageTypes: ['image'],
      preferences: config.report.preferences
    })
    expect(generated.success).toBe(true)
    expect(mocks.chat.mock.calls[0][0][1].content).toBe(manual.prompt)
    expect(mocks.chat.mock.calls[0][1]).toMatchObject({
      providerId: 'fixture-other',
      modelId: 'fixture-selected-text'
    })
    expect(generated.reportMetadata?.reportPreferences).toEqual(preferences)
    expect(generated.reportSnapshot?.media.visionGallery).toHaveLength(4)
    expect(runtime.imageAnalyze).not.toHaveBeenCalled()
  })
  it('inherits saved preferences when no rule override is supplied', async () => {
    const generated = await generateAgentGroupReport({
      group: contact.m_nsUsrName,
      messageTypes: ['image'],
      range: 'custom',
      customRange: { start: '2026-10-01T00:00', end: '2026-10-02T00:00' }
    })
    expect(generated.success).toBe(true)
    expect(generated.reportMetadata?.reportPreferences?.imageLimit).toBe(8)
    expect(generated.reportMetadata?.footerNote).toContain('本地 OCR 4 张')
  })
  it('stops before any model request when the requested date window is invalid', async () => {
    const generated = await generateAgentGroupReport({
      group: contact.m_nsUsrName,
      range: 'custom',
      customRange: { start: '2026-10-02', end: '2026-10-01' }
    })
    expect(generated.success).toBe(false)
    expect(mocks.chat).not.toHaveBeenCalled()
  })
  it('rejects invalid explicit processing preferences before reading or sending images', async () => {
    const generated = await generateAgentGroupReport({
      group: contact.m_nsUsrName,
      preferences: { imageMethod: 'ocr_only' } as never
    })
    expect(generated.success).toBe(false)
    expect(generated.errorStage).toBe('precheck')
    expect(mocks.chat).not.toHaveBeenCalled()
  })

  it('uses identical long-record evidence for manual and background reports and retains full statistics', async () => {
    messages.splice(
      0,
      messages.length,
      ...Array.from(
        { length: 6 },
        (_, index): Message => ({
          id: `fixture-long-${index}`,
          from: 'fixture-member',
          name: '示例成员',
          type: '普通文本',
          datetime: `2026-10-0${index + 1} 10:00:00`,
          isSender: false,
          content: '示例讨论。'.repeat(1_600),
          contentData: { type: 'text', content: '示例讨论。'.repeat(1_600) }
        })
      )
    )
    const preferences = normalizeReportPreferences({
      imageLimit: 0,
      textModel: { providerId: 'fixture-other', model: 'fixture-text' }
    })
    const manual = await buildGroupReportInput(messages, contact, true, 'full', {
      imageApi: runtime,
      preferences,
      imageLimit: 0
    })
    const prepared = await prepareLongReportInput({
      prompt: manual.prompt,
      source: manual.summarySource,
      systemPrompt: GROUP_REPORT_SYSTEM_PROMPT,
      deadlineAt: Date.now() + 60_000,
      summarize: async () => ({
        success: true,
        data: '[fixture-long-5] 2026-10-06 示例成员确认需求',
        usage: { input: 10, output: 2, total: 12 }
      })
    })
    const reportResponse = await mocks.chat()
    mocks.chat.mockClear()
    mocks.chat.mockImplementation(async (input) =>
      input[0].content.includes('证据整理员')
        ? {
            success: true,
            data: '[fixture-long-5] 2026-10-06 示例成员确认需求',
            usage: { input: 10, output: 2, total: 12 }
          }
        : { ...reportResponse, usage: { input: 8, output: 2, total: 10 } }
    )
    const generated = await generateAgentGroupReport({
      group: contact.m_nsUsrName,
      preferences,
      messageTypes: ['text']
    })
    expect(generated.success).toBe(true)
    expect(mocks.chat.mock.calls.at(-1)![0][1].content).toBe(prepared.prompt)
    expect(generated.messageCount).toBe(6)
    expect(generated.reportMetadata?.messageCount).toBe(6)
    expect(generated.reportMetadata?.longRecordSummary?.chunks).toBe(prepared.stats?.chunks)
    expect(generated.reportMetadata?.recordNote).toContain('压缩可能省略细节')
    expect(generated.tokenUsage?.total).toBe(prepared.usage!.total! + 10)
    for (const [, options] of mocks.chat.mock.calls) {
      expect(options).toMatchObject({ providerId: 'fixture-other', modelId: 'fixture-text' })
      expect(options.timeoutMs).toBeLessThanOrEqual(300_000)
    }
  })

  it('does not export an incomplete background report after a chunk failure', async () => {
    messages.splice(0, messages.length, {
      ...originalMessages[0],
      type: '普通文本',
      content: 'fixture'.repeat(8_000),
      contentData: { type: 'text', content: 'fixture'.repeat(8_000) }
    })
    mocks.chat.mockResolvedValue({
      success: false,
      error: 'fixture-unavailable',
      errorStatus: 503,
      errorType: 'fixture-service'
    })
    const generated = await generateAgentGroupReport({
      group: contact.m_nsUsrName,
      messageTypes: ['text']
    })
    expect(generated).toMatchObject({
      success: false,
      errorStage: 'ai',
      errorStatus: 503,
      errorType: 'fixture-service'
    })
    expect(generated.error).toContain('分段总结 1/')
    expect(mocks.chat).toHaveBeenCalledTimes(1)
    expect(mocks.export).not.toHaveBeenCalled()
  })

  it.each(['final', 'repair'])('does not export a truncated %s response', async (stage) => {
    const valid = JSON.stringify({
      topics: [{ title: 'fixture', summary: 'fixture', keywords: [], heat: '高' }]
    })
    mocks.chat.mockResolvedValue({ success: true, data: valid, finishReason: 'length' })
    if (stage === 'repair')
      mocks.chat.mockResolvedValueOnce({
        success: true,
        data: 'fixture invalid json',
        finishReason: 'stop'
      })
    const generated = await generateAgentGroupReport({
      group: contact.m_nsUsrName,
      messageTypes: ['image']
    })
    expect(generated.success).toBe(false)
    expect(generated.error).toContain('length')
    expect(mocks.export).not.toHaveBeenCalled()
    expect(mocks.chat).toHaveBeenCalledTimes(stage === 'final' ? 1 : 2)
  })
})
