import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IMAGE_INSIGHT_CACHE_TTL_MS,
  isFreshImageInsight,
  normalizeReportImageLimit,
  type ImageInsight
} from '../../src/shared/image-insight'

const { getByHash, upsert } = vi.hoisted(() => ({
  getByHash: vi.fn(),
  upsert: vi.fn()
}))

vi.mock('../../src/main/db/image-insights-store', () => ({
  imageInsightsStore: {
    getByHash,
    upsert,
    listBySession: vi.fn()
  }
}))

import { imageInsightService } from '../../src/main/services/image-insight-service'

const query = {
  sessionId: 'group@chatroom',
  startTime: 0,
  endTime: Date.now(),
  limit: 3
}

const input = (
  id: string,
  responseCount: number,
  interactionCount: number
): {
  messageId: string
  md5: string
  sessionId: string
  sender: string
  sentAt: number
  responseCount: number
  interactionCount: number
} => ({
  messageId: id,
  md5: id.repeat(32).slice(0, 32),
  sessionId: 'group@chatroom',
  sender: id,
  sentAt: Date.now(),
  responseCount,
  interactionCount
})

describe('ImageInsightService hot image selection', () => {
  beforeEach(() => {
    getByHash.mockReset()
    getByHash.mockReturnValue(null)
    upsert.mockReset()
  })

  it('returns fewer than three images when only two pass the hot threshold', async () => {
    const result = await imageInsightService.listTopHotImages(query, [
      input('a', 3, 0),
      input('b', 1, 1),
      input('c', 1, 0),
      input('d', 0, 5),
      input('e', 0, 0)
    ])

    expect(result.map((item) => item.messageId)).toEqual(['a', 'b'])
  })

  it('keeps the three highest-scoring hot images when more are eligible', async () => {
    const result = await imageInsightService.listTopHotImages(query, [
      input('a', 2, 0),
      input('b', 5, 0),
      input('c', 1, 1),
      input('d', 3, 1)
    ])

    expect(result.map((item) => item.messageId)).toEqual(['b', 'd', 'a'])
    expect(result).toHaveLength(3)
  })

  it('accepts limits above three and enforces the twenty-image server limit', async () => {
    const inputs = Array.from({ length: 25 }, (_, index) => ({
      ...input(`fixture-${index}`, 2, 0),
      md5: index.toString(16).padStart(32, '0')
    }))
    expect(
      await imageInsightService.listTopHotImages({ ...query, limit: 10 }, inputs)
    ).toHaveLength(10)
    expect(
      await imageInsightService.listTopHotImages({ ...query, limit: 100 }, inputs)
    ).toHaveLength(20)
    expect(await imageInsightService.listTopHotImages({ ...query, limit: 0 }, inputs)).toEqual([])
  })

  it('prioritizes hot images and fills remaining slots with ordinary images when enabled', async () => {
    const inputs = [input('a', 0, 10), input('b', 2, 0), input('c', 0, 0)]
    const result = await imageInsightService.listTopHotImages(
      { ...query, selectionMode: 'hot-first' },
      inputs
    )
    expect(result.map((candidate) => candidate.messageId)).toEqual(['b', 'a', 'c'])
    expect(
      (await imageInsightService.listTopHotImages(query, inputs)).map(
        (candidate) => candidate.messageId
      )
    ).toEqual(['b'])
  })

  it('counts repeated images once and keeps their strongest discussion as the source', async () => {
    const duplicate = { ...input('b', 3, 0), md5: 'a'.repeat(32) }
    const result = await imageInsightService.listTopHotImages(query, [
      input('a', 2, 0),
      duplicate,
      input('c', 2, 0)
    ])
    expect(result.map((candidate) => candidate.messageId)).toEqual(['b', 'c'])
  })

  it('accounts for every image using mutually exclusive selection reasons', async () => {
    const result = await imageInsightService.selectReportImages({ ...query, limit: 1 }, [
      input('a', 2, 0),
      { ...input('b', 3, 0), md5: 'a'.repeat(32) },
      input('c', 2, 0),
      input('d', 0, 0),
      { ...input('e', 2, 0), md5: '', datName: undefined }
    ])
    expect(result.candidates.map((candidate) => candidate.messageId)).toEqual(['b'])
    expect(result.selection).toEqual({
      inputCount: 5,
      excludedByHotRule: 1,
      unavailable: 1,
      duplicates: 1,
      excludedByLimit: 1,
      disabled: false
    })
  })

  it('reports disabled selection without looking up image caches', async () => {
    const result = await imageInsightService.selectReportImages({ ...query, limit: 0 }, [
      input('a', 2, 0)
    ])
    expect(result).toMatchObject({ candidates: [], selection: { inputCount: 1, disabled: true } })
    expect(getByHash).not.toHaveBeenCalled()
  })

  it.each([
    [undefined, 3],
    [null, 3],
    ['', 3],
    [NaN, 3],
    [Infinity, 3],
    [-1, 0],
    [0, 0],
    [7.9, 7],
    ['12', 12],
    [100, 20]
  ])('normalizes the image limit %s to %s', (value, expected) => {
    expect(normalizeReportImageLimit(value)).toBe(expected)
  })

  it('returns no candidates when no image has meaningful follow-up activity', async () => {
    const result = await imageInsightService.listTopHotImages(query, [
      input('a', 1, 0),
      input('b', 0, 4),
      input('c', 0, 0)
    ])

    expect(result).toEqual([])
  })

  it('keeps a cached insight attached to an eligible candidate', async () => {
    const cached = {
      imageHash: 'a'.repeat(32),
      description: '缓存识别结果',
      updatedAt: Date.now()
    }
    getByHash.mockImplementation((hash: string) => (hash === 'a'.repeat(32) ? cached : null))

    const result = await imageInsightService.listTopHotImages(query, [input('a', 2, 0)])

    expect(result[0]).toMatchObject({ messageId: 'a', insight: cached })
  })

  it('does not attach a cached insight once its 10-minute TTL has elapsed', async () => {
    getByHash.mockReturnValue({
      imageHash: 'a'.repeat(32),
      description: '过期识别结果',
      updatedAt: Date.now() - IMAGE_INSIGHT_CACHE_TTL_MS
    })

    const result = await imageInsightService.listTopHotImages(query, [input('a', 2, 0)])

    expect(result[0]).not.toHaveProperty('insight')
  })
})

describe('ImageInsightService cache TTL and vision routing', () => {
  const now = new Date('2026-08-12T10:00:00.000Z').getTime()
  const cachedInsight = (updatedAt: number): ImageInsight => ({
    id: 'cached-insight',
    messageId: 'image-1',
    imageHash: 'a'.repeat(32),
    description: '缓存图片描述',
    tags: ['缓存'],
    category: 'screenshot',
    importance: 'medium',
    provider: 'vision-provider',
    model: 'vision-model',
    createdAt: updatedAt,
    updatedAt,
    sender: '成员一',
    sentAt: now,
    sessionId: 'group@chatroom'
  })

  beforeEach(() => {
    vi.useRealTimers()
    getByHash.mockReset()
    getByHash.mockReturnValue(null)
    upsert.mockReset()
  })

  it('treats only results strictly newer than 10 minutes as fresh', () => {
    expect(isFreshImageInsight(cachedInsight(now - IMAGE_INSIGHT_CACHE_TTL_MS + 1), now)).toBe(true)
    expect(isFreshImageInsight(cachedInsight(now - IMAGE_INSIGHT_CACHE_TTL_MS), now)).toBe(false)
    expect(isFreshImageInsight(cachedInsight(0), now)).toBe(false)
  })

  it('uses the independent vision runtime after an expired cache entry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    getByHash.mockReturnValue(cachedInsight(now - IMAGE_INSIGHT_CACHE_TTL_MS))
    const analyzeImage = vi.fn(async () => ({
      success: true,
      data: JSON.stringify({
        description: '重新识别后的图片描述',
        ocrText: '新的 OCR',
        tags: ['更新', '截图'],
        category: 'screenshot',
        importance: 'high'
      })
    }))
    const getVisionRuntimeConfig = vi.fn(() => ({
      providerId: 'sol-provider',
      providerName: 'OpenAI',
      model: 'gpt-5.6-sol',
      modelName: 'gpt-5.6-sol',
      configured: true
    }))
    imageInsightService.bind({
      providerService: {
        list: () => ({ providers: [], defaultProviderId: 'deepseek' }),
        getVisionRuntimeConfig,
        analyzeImage
      },
      decryptService: {
        findImageFile: () => null,
        decryptImageToBase64: () => null
      }
    })

    const result = await imageInsightService.analyze({
      imageHash: 'a'.repeat(32),
      imageDataUrl: 'data:image/png;base64,fixture',
      messageId: 'image-1',
      sender: '成员一',
      sentAt: now,
      sessionId: 'group@chatroom'
    })

    expect(result).toMatchObject({ success: true, fromCache: false })
    expect(analyzeImage).toHaveBeenCalledWith(expect.any(Array), {
      providerId: 'sol-provider',
      modelId: 'gpt-5.6-sol'
    })
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        description: '重新识别后的图片描述',
        provider: 'sol-provider',
        model: 'gpt-5.6-sol',
        updatedAt: now
      })
    )
  })

  it('uses the report-selected vision model on a cache miss', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const analyzeImage = vi.fn(async () => ({
      success: true,
      data: JSON.stringify({
        description: '指定模型识别结果',
        tags: ['指定'],
        category: 'screenshot',
        importance: 'medium'
      })
    }))
    const getVisionRuntimeConfig = vi.fn(() => ({
      providerId: 'automatic-provider',
      providerName: '自动模型',
      model: 'automatic-vision',
      modelName: '自动视觉模型',
      configured: true
    }))
    imageInsightService.bind({
      providerService: {
        list: () => ({ providers: [], defaultProviderId: 'automatic-provider' }),
        getVisionRuntimeConfig,
        analyzeImage
      },
      decryptService: {
        findImageFile: () => null,
        decryptImageToBase64: () => null
      }
    })

    const result = await imageInsightService.analyze({
      imageHash: 'b'.repeat(32),
      imageDataUrl: 'data:image/png;base64,fixture',
      messageId: 'image-selected',
      sender: '成员二',
      sentAt: now,
      sessionId: 'group@chatroom',
      providerId: 'selected-provider',
      modelId: 'selected-vision'
    })

    expect(result).toMatchObject({ success: true, fromCache: false })
    expect(analyzeImage).toHaveBeenCalledWith(expect.any(Array), {
      providerId: 'selected-provider',
      modelId: 'selected-vision'
    })
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'selected-provider', model: 'selected-vision' })
    )
  })

  it('returns a fresh cached result without calling the vision model', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const cached = cachedInsight(now - IMAGE_INSIGHT_CACHE_TTL_MS + 1)
    getByHash.mockReturnValue(cached)
    const analyzeImage = vi.fn()
    imageInsightService.bind({
      providerService: {
        list: () => ({ providers: [], defaultProviderId: 'deepseek' }),
        getVisionRuntimeConfig: () => ({
          providerId: 'sol-provider',
          providerName: 'OpenAI',
          model: 'gpt-5.6-sol',
          modelName: 'gpt-5.6-sol',
          configured: true
        }),
        analyzeImage
      },
      decryptService: {
        findImageFile: () => null,
        decryptImageToBase64: () => null
      }
    })

    const result = await imageInsightService.analyze({
      imageHash: cached.imageHash,
      imageDataUrl: 'data:image/png;base64,fixture',
      messageId: cached.messageId,
      sender: cached.sender,
      sentAt: cached.sentAt,
      sessionId: cached.sessionId
    })

    expect(result).toEqual({ success: true, insight: cached, fromCache: true })
    expect(analyzeImage).not.toHaveBeenCalled()
    expect(upsert).not.toHaveBeenCalled()
  })

  it('does not reuse another model cache when a report explicitly selects its vision model', async () => {
    getByHash.mockReturnValue(cachedInsight(Date.now()))
    const analyzeImage = vi.fn(async () => ({
      success: true,
      data: JSON.stringify({
        description: 'fixture-selected-result',
        tags: [],
        category: 'photo',
        importance: 'medium'
      })
    }))
    imageInsightService.bind({
      providerService: {
        list: () => ({ providers: [] }),
        getVisionRuntimeConfig: () => ({
          configured: true,
          providerName: 'fixture',
          providerId: 'fixture-default',
          model: 'fixture-default',
          modelName: 'fixture'
        }),
        analyzeImage
      },
      decryptService: { findImageFile: () => null, decryptImageToBase64: () => null }
    })
    const result = await imageInsightService.analyze({
      imageHash: 'a'.repeat(32),
      imageDataUrl: 'data:image/png;base64,fixture',
      messageId: 'fixture-current',
      sender: 'fixture-member',
      sentAt: Date.now(),
      sessionId: 'fixture-group@chatroom',
      providerId: 'fixture-selected',
      modelId: 'fixture-vision'
    })
    expect(analyzeImage).toHaveBeenCalledTimes(1)
    expect(result.insight).toMatchObject({ provider: 'fixture-selected', model: 'fixture-vision' })
  })
})
