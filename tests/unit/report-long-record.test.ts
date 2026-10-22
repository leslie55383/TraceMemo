import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  packReportSummaryRecords,
  prepareLongReportInput,
  REPORT_INPUT_CHAR_BUDGET,
  type ReportSummaryResponse,
  type ReportSummarySource
} from '../../src/shared/report-long-record'

const source = (count = 5): ReportSummarySource => ({
  context: 'fixture群；消息数 5；活跃人数 1；模块：通知、待办',
  records: Array.from({ length: count }, (_, index) => ({
    label: `[fixture-${index}] 2026-10-${String(index + 1).padStart(2, '0')} 10:00 示例成员：`,
    content: `fixture-${index}-begin ` + '示例公告和讨论。'.repeat(1_000) + ` fixture-${index}-end`
  }))
})
const settings = (records = source()) => ({
  prompt: 'fixture-raw'.repeat(4_000),
  source: records,
  systemPrompt: 'fixture-report-system',
  deadlineAt: Date.now() + 60_000
})
const success = (data = '[fixture-0] 2026-10-01 示例成员确认需求'): ReportSummaryResponse => ({
  success: true,
  data,
  finishReason: 'stop',
  usage: { input: 20, output: 10, total: 30 }
})

afterEach(() => vi.useRealTimers())

describe('long report evidence processing', () => {
  it('keeps short reports on exactly the original single-request path', async () => {
    const summarize = vi.fn()
    const result = await prepareLongReportInput({
      ...settings(),
      prompt: 'short fixture',
      summarize
    })
    expect(result).toEqual({ prompt: 'short fixture' })
    expect(summarize).not.toHaveBeenCalled()
  })

  it('packs oversized messages losslessly and repeats attribution without breaking emoji', () => {
    const content = '消息😀'.repeat(9_000)
    const label = '[fixture-large] 2026-10-01 示例成员：'
    const chunks = packReportSummaryRecords([{ label, content }])
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.length <= 10_000 && chunk.startsWith(label))).toBe(true)
    expect(chunks.map((chunk) => chunk.slice(label.length + 1)).join('')).toBe(content)
    expect(chunks.some((chunk) => /[\uD800-\uDBFF]$/.test(chunk))).toBe(false)
  })

  it('covers first, middle and last records with bounded requests and aggregates all usage', async () => {
    const records = source()
    const calls: string[] = []
    const result = await prepareLongReportInput({
      ...settings(records),
      summarize: async (messages) => {
        expect(messages.reduce((sum, m) => sum + m.content.length, 0)).toBeLessThanOrEqual(
          REPORT_INPUT_CHAR_BUDGET
        )
        calls.push(messages[1].content)
        return success()
      }
    })
    const all = calls.join('\n')
    for (let i = 0; i < records.records.length; i++) {
      expect(all).toContain(`fixture-${i}-begin`)
      expect(all).toContain(`fixture-${i}-end`)
      expect(all).toContain(`[fixture-${i}]`)
    }
    expect(result.stats?.chunks).toBe(calls.length)
    expect(result.usage?.total).toBe(calls.length * 30)
    expect(result.prompt).toContain('消息数 5；活跃人数 1')
    expect(result.prompt).toContain('不是逐字原文')
    expect(result.prompt.length + settings().systemPrompt.length).toBeLessThanOrEqual(
      REPORT_INPUT_CHAR_BUDGET
    )
  })

  it('reduces many chunk summaries again before making the final report prompt', async () => {
    const summarize = vi.fn(async (messages: { role: string; content: string }[]) =>
      success(
        messages[1].content.includes('合并第') ? '[fixture-0] 合并结果' : '段落证据。'.repeat(600)
      )
    )
    const result = await prepareLongReportInput({ ...settings(source(16)), summarize })
    expect(result.stats?.reductionPasses).toBeGreaterThan(0)
    expect(result.stats!.summaryRequests).toBeGreaterThan(result.stats!.chunks)
    expect(result.prompt.length).toBeLessThan(REPORT_INPUT_CHAR_BUDGET)
    expect(result.usage?.total).toBe(summarize.mock.calls.length * 30)
  })

  it('reuses successful chunks after a failure and continues from the failed chunk', async () => {
    const cache = new Map()
    const summarize = vi
      .fn()
      .mockResolvedValue(success())
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce({ success: false, error: 'fixture-offline' })
    await expect(prepareLongReportInput({ ...settings(), cache, summarize })).rejects.toThrow(
      'fixture-offline'
    )
    expect(summarize).toHaveBeenCalledTimes(2)
    const result = await prepareLongReportInput({ ...settings(), cache, summarize })
    expect(
      summarize.mock.calls.filter(([messages]) => messages[1].content.includes('总结 1/'))
    ).toHaveLength(1)
    expect(result.usage?.total).toBe(result.stats!.summaryRequests * 30)
  })

  it.each([
    { success: false, error: 'fixture-failed' },
    { success: true, data: '' },
    { success: true, data: 'incomplete', finishReason: 'length' },
    { success: true, data: 'oversized'.repeat(600) }
  ])('does not silently skip an invalid chunk response %#', async (response) => {
    const summarize = vi.fn(async () => response)
    await expect(prepareLongReportInput({ ...settings(), summarize })).rejects.toThrow()
    expect(summarize).toHaveBeenCalledTimes(1)
  })

  it('preserves provider error details for background failure reporting', async () => {
    const response = {
      success: false,
      error: 'fixture-quota',
      errorCode: 'RATE_LIMIT',
      errorStatus: 429
    }
    await expect(
      prepareLongReportInput({ ...settings(), summarize: async () => response })
    ).rejects.toMatchObject({ response })
  })

  it('estimates summary usage when the provider does not return token counters', async () => {
    const result = await prepareLongReportInput({
      ...settings(),
      summarize: async () => ({ success: true, data: 'fixture' })
    })
    expect(result.usage?.estimated).toBe(true)
    expect(result.usage?.total).toBeGreaterThan(0)
  })

  it('rejects over-budget source data before starting any model calls', async () => {
    const summarize = vi.fn()
    await expect(prepareLongReportInput({ ...settings(source(100)), summarize })).rejects.toThrow(
      '处理上限'
    )
    expect(summarize).not.toHaveBeenCalled()
  })

  it('converges even when every chunk returns the longest accepted summary', async () => {
    const summarize = vi.fn(async () => success('证据。'.repeat(1_300)))
    const result = await prepareLongReportInput({ ...settings(source(16)), summarize })
    expect(result.prompt.length).toBeLessThan(REPORT_INPUT_CHAR_BUDGET)
    expect(summarize.mock.calls.length).toBeLessThan(100)
  })

  it('applies one deadline across chunks and never starts the next chunk after timeout', async () => {
    vi.useFakeTimers()
    const summarize = vi.fn(() => new Promise<ReportSummaryResponse>(() => {}))
    const promise = prepareLongReportInput({
      ...settings(),
      deadlineAt: Date.now() + 50,
      summarize
    })
    const check = expect(promise).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(51)
    await check
    expect(summarize).toHaveBeenCalledTimes(1)
  })

  it('rejects an expired task without sending anything', async () => {
    const summarize = vi.fn()
    await expect(
      prepareLongReportInput({ ...settings(), deadlineAt: Date.now() - 1, summarize })
    ).rejects.toThrow('超时')
    expect(summarize).not.toHaveBeenCalled()
  })
})
