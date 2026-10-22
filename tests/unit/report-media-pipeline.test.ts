import { describe, expect, it, vi } from 'vitest'
import { buildGroupReportInput } from '../../src/renderer/src/utils/group-report'
import type { ReportMediaApi } from '../../src/renderer/src/utils/group-report-facts'
import type { Message } from '../../src/shared/types'
import type { ImageAnalysisRequest, ImageInsight } from '../../src/shared/image-insight'
import type { SystemOcrResult } from '../../src/shared/system-ocr'

const messages: Message[] = [0, 1].map((index) => ({
  id: `fixture-image-${index}`,
  from: 'fixture-member',
  name: '示例成员',
  type: '图片',
  datetime: `2026-10-01 10:0${index}:00`,
  content: '[图片]',
  isSender: false,
  sessionId: 'fixture-group@chatroom',
  contentData: { type: 'image', md5: String(index).repeat(32) }
}))
const ocrResult = (text: string): SystemOcrResult => ({
  success: Boolean(text),
  text,
  lines: [],
  language: 'zh-Hans-CN',
  engine: 'windows-system-ocr',
  durationMs: 1
})
function api() {
  const imageAnalyze = vi.fn(async (request: ImageAnalysisRequest) => ({
    success: true,
    insight: {
      ...request,
      id: request.messageId,
      description: 'fixture-vision-result',
      tags: [],
      category: 'photo',
      importance: 'medium',
      provider: 'fixture-provider',
      model: 'fixture-vision',
      createdAt: Date.now(),
      updatedAt: Date.now()
    } as ImageInsight
  }))
  const runtime = {
    imageListCandidates: vi.fn(async (query) => ({
      success: true,
      candidates: (query.inputs || [])
        .slice(0, query.limit)
        .map((input) => ({ ...input, imageHash: input.md5!, heatScore: 1 }))
    })),
    imageAnalyze,
    getImage: vi.fn(async () => ({ success: true, data: 'data:image/png;base64,fixture' })),
    recognizeLocalImageText: vi.fn(async () => ocrResult('fixture公告：周五确认需求'))
  } satisfies ReportMediaApi
  return runtime
}
describe('shared report media pipeline without Renderer globals', () => {
  it('runs local OCR without calling a vision provider and labels its source', async () => {
    const runtime = api()
    const input = await buildGroupReportInput(messages, null, true, 'full', {
      imageApi: runtime,
      imageSelectionMode: 'hot-first',
      imageLimit: 2,
      imageMethod: 'ocr-only'
    })
    expect(runtime.imageAnalyze).not.toHaveBeenCalled()
    expect(runtime.recognizeLocalImageText).toHaveBeenCalledTimes(2)
    expect(input.prompt).toContain('fixture公告：周五确认需求')
    expect(input.imageInsightSummary.items[0].source).toBe('local-ocr')
    expect(input.metadata.footerNote).toContain('本地 OCR 2 张')
  })
  it('uses the vision model only for OCR-empty pictures when fallback is selected', async () => {
    const runtime = api()
    runtime.recognizeLocalImageText
      .mockResolvedValueOnce(ocrResult(''))
      .mockResolvedValueOnce(ocrResult('fixture-文字'))
    const input = await buildGroupReportInput(messages, null, true, 'full', {
      imageApi: runtime,
      imageSelectionMode: 'hot-first',
      imageMethod: 'ocr-first'
    })
    expect(runtime.imageAnalyze).toHaveBeenCalledTimes(1)
    expect(input.imageInsightSummary.succeeded).toBe(2)
  })
  it('never silently uploads an OCR-only failure and reuses successes during retry', async () => {
    const runtime = api()
    runtime.recognizeLocalImageText
      .mockResolvedValueOnce(ocrResult('fixture-文字'))
      .mockResolvedValueOnce(ocrResult(''))
    const first = await buildGroupReportInput(messages, null, true, 'full', {
      imageApi: runtime,
      imageSelectionMode: 'hot-first',
      imageMethod: 'ocr-only'
    })
    expect(first.imageInsightSummary).toMatchObject({ succeeded: 1, failed: 1 })
    const retry = await buildGroupReportInput(messages, null, true, 'full', {
      imageApi: runtime,
      imageSelectionMode: 'hot-first',
      imageMethod: 'ocr-only',
      previousInsights: first.imageInsightSummary.items
    })
    expect(retry.imageInsightSummary).toMatchObject({ succeeded: 2, failed: 0 })
    expect(runtime.recognizeLocalImageText).toHaveBeenCalledTimes(3)
    expect(runtime.imageAnalyze).not.toHaveBeenCalled()
  })
  it('only submits explicitly selected images and allows a manually selected ordinary picture', async () => {
    const runtime = api()
    await buildGroupReportInput(messages, null, true, 'full', {
      imageApi: runtime,
      selectedImageIds: ['fixture-image-1']
    })
    expect(runtime.imageAnalyze).toHaveBeenCalledTimes(1)
    expect(runtime.imageListCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        selectionMode: 'hot-first',
        inputs: [expect.objectContaining({ messageId: 'fixture-image-1' })]
      })
    )
  })
})
