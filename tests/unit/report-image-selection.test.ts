import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildGroupReportInput } from '../../src/renderer/src/utils/group-report'
import type {
  ImageAnalysisRequest,
  ImageCandidateQuery,
  ImageInsight
} from '../../src/shared/image-insight'
import type { Message } from '../../src/shared/types'
import { imageInsightService } from '../../src/main/services/image-insight-service'

vi.mock('../../src/main/db/image-insights-store', () => ({
  imageInsightsStore: { getByHash: () => null }
}))

const previousWindow = (globalThis as { window?: unknown }).window
afterEach(() => {
  if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
  else Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
})

const messages: Message[] = Array.from({ length: 10 }, (_, index) => ({
  id: `fixture-image-${index}`,
  from: 'member',
  type: '图片',
  datetime: new Date(2026, 7, 12, 0, index * 20).toISOString(),
  content: '[图片]',
  name: '示例成员',
  isSender: false,
  sessionId: 'fixture-group@chatroom',
  contentData: { type: 'image', md5: index.toString(16).padStart(32, '0') }
}))

function mockApi(): {
  imageListCandidates: ReturnType<typeof vi.fn>
  imageAnalyze: ReturnType<typeof vi.fn>
  getImage: ReturnType<typeof vi.fn>
  maxConcurrent: () => number
} {
  let concurrent = 0
  let maxConcurrent = 0
  const api = {
    imageListCandidates: vi.fn(async (query: ImageCandidateQuery) => ({
      success: true,
      ...(await imageInsightService.selectReportImages(query, query.inputs))
    })),
    getImage: vi.fn(async () => ({ success: true, data: 'data:image/png;base64,fixture' })),
    imageAnalyze: vi.fn(async (request: ImageAnalysisRequest) => {
      maxConcurrent = Math.max(maxConcurrent, ++concurrent)
      await new Promise((resolve) => setTimeout(resolve, 1))
      concurrent--
      const insight: ImageInsight = {
        id: request.messageId,
        messageId: request.messageId,
        imageHash: request.imageHash,
        description: `识别结果 ${request.messageId}`,
        tags: [],
        category: 'screenshot',
        importance: 'medium',
        provider: 'fixture-provider',
        model: 'fixture-vision',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sender: request.sender,
        sentAt: request.sentAt,
        sessionId: request.sessionId
      }
      return { success: true, insight }
    })
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api } })
  return { ...api, maxConcurrent: () => maxConcurrent }
}

describe('configurable report image pipeline', () => {
  it('includes more than six ordinary images in the model prompt and limits concurrency to three', async () => {
    const api = mockApi()
    const report = await buildGroupReportInput(messages, null, true, 'full', {
      imageLimit: 10,
      imageSelectionMode: 'hot-first'
    })
    expect(api.imageListCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 10,
        selectionMode: 'hot-first',
        inputs: expect.arrayContaining([expect.objectContaining({ messageId: 'fixture-image-9' })])
      })
    )
    expect(api.imageListCandidates.mock.calls[0][0].inputs).toHaveLength(10)
    expect(api.imageAnalyze).toHaveBeenCalledTimes(10)
    expect(api.maxConcurrent()).toBe(3)
    expect(report.imageInsightSummary).toMatchObject({ total: 10, succeeded: 10, failed: 0 })
    expect(report.media.visionGallery).toHaveLength(10)
    expect(report.prompt).toContain('识别结果 fixture-image-9')
  })

  it('preserves the hot-only default without promoting ordinary images', async () => {
    const api = mockApi()
    const report = await buildGroupReportInput(messages, null, true, 'full')
    expect(api.imageListCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3, selectionMode: 'hot-only', inputs: expect.any(Array) })
    )
    expect(api.imageAnalyze).not.toHaveBeenCalled()
    expect(report.imageInsightSummary.total).toBe(0)
    expect(report.imageInsightSummary.selection).toMatchObject({
      inputCount: 10,
      excludedByHotRule: 10,
      excludedByLimit: 0,
      disabled: false
    })
  })

  it('skips image requests when the configured limit is zero', async () => {
    const api = mockApi()
    const report = await buildGroupReportInput(messages, null, true, 'full', {
      imageLimit: 0,
      imageSelectionMode: 'hot-first'
    })
    expect(api.imageListCandidates).not.toHaveBeenCalled()
    expect(api.imageAnalyze).not.toHaveBeenCalled()
    expect(api.getImage).not.toHaveBeenCalled()
    expect(report.imageInsightSummary).toMatchObject({ total: 0, succeeded: 0, failed: 0 })
    expect(report.imageInsightSummary.selection).toMatchObject({ inputCount: 10, disabled: true })
  })

  it('reports duplicate and limit exclusions from the actual main-process selection', async () => {
    const api = mockApi()
    const report = await buildGroupReportInput(
      [...messages, { ...messages[0], id: 'fixture-duplicate' }],
      null,
      true,
      'full',
      {
        imageLimit: 4,
        imageSelectionMode: 'hot-first'
      }
    )
    expect(api.imageAnalyze).toHaveBeenCalledTimes(4)
    expect(report.imageInsightSummary).toMatchObject({
      total: 4,
      succeeded: 4,
      selection: { inputCount: 11, duplicates: 1, excludedByLimit: 6, excludedByHotRule: 0 }
    })
  })

  it('keeps the current message source when the same image has a cached result from another group', async () => {
    const api = mockApi()
    const cached: ImageInsight = {
      id: 'fixture-cached',
      imageHash: '0'.repeat(32),
      messageId: 'fixture-other-message',
      description: '可复用的图片内容',
      tags: [],
      category: 'screenshot',
      importance: 'medium',
      provider: 'fixture-provider',
      model: 'fixture-vision',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sender: 'fixture-other-member',
      sentAt: 1,
      sessionId: 'fixture-other-group@chatroom'
    }
    api.imageListCandidates.mockImplementationOnce(async (query: ImageCandidateQuery) => ({
      success: true,
      candidates: [
        { ...query.inputs![0], imageHash: cached.imageHash, heatScore: 1, insight: cached }
      ]
    }))
    const report = await buildGroupReportInput([messages[0]], null, true, 'full', {
      imageLimit: 1,
      imageSelectionMode: 'hot-first'
    })
    expect(api.imageAnalyze).not.toHaveBeenCalled()
    expect(report.media.visionGallery![0]).toMatchObject({
      messageId: messages[0].id,
      sender: messages[0].name,
      sourceMessageIds: [messages[0].id],
      description: cached.description,
      imageUrl: 'data:image/png;base64,fixture'
    })
    expect(report.prompt).not.toContain('fixture-other-member')
  })
})
