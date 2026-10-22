import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useGroupReportGeneration } from '../../src/renderer/src/hooks/useGroupReportGeneration'
import { ReportContentSettings } from '../../src/renderer/src/components/reports/ReportContentSettings'
import { ReportImagePicker } from '../../src/renderer/src/components/reports/ReportImagePicker'
import { ReportRangeSelector } from '../../src/renderer/src/components/reports/ReportRangeSelector'
import type { Message, Contact } from '../../src/shared/types'
import type { ImageAnalysisRequest, ImageInsight } from '../../src/shared/image-insight'
import type { SummaryMessageType } from '../../src/renderer/src/utils/group-report'

const contact: Contact = {
  md5: 'fixture-group-md5',
  m_nsUsrName: 'fixture-group@chatroom',
  m_nsNickName: '示例群',
  type: 'group'
}
const messages: Message[] = [0, 1].map((index) => ({
  id: `fixture-image-${index}`,
  from: 'fixture-member',
  name: '示例成员',
  type: '图片',
  datetime: `2026-10-01 10:0${index}:00`,
  content: '[图片]',
  isSender: false,
  sessionId: contact.m_nsUsrName,
  contentData: { type: 'image', md5: String(index).repeat(32) }
}))
const model = {
  providerId: 'fixture-provider',
  providerName: 'fixture-provider',
  model: 'fixture-model',
  modelName: 'fixture-model',
  configured: true,
  status: 'connected' as const
}
const types: SummaryMessageType[] = ['image']
let state: ReturnType<typeof useGroupReportGeneration>
function Harness({
  messageTypes = types
}: {
  messageTypes?: SummaryMessageType[]
}): React.ReactElement {
  state = useGroupReportGeneration({
    sourceContact: contact,
    summaryDateRange: 'today',
    summaryMessageTypes: messageTypes,
    modelConfig: model
  })
  return (
    <>
      <ReportContentSettings
        value={state.reportPreferences}
        onChange={state.setReportPreferences}
      />
      <ReportImagePicker
        contact={contact}
        messages={state.reportMessages}
        limit={state.reportImageLimit}
        mode={state.reportImageSelectionMode}
        value={state.selectedImageIds}
        onChange={state.setSelectedImageIds}
      />
      <button onClick={() => void state.generate()}>fixture-generate</button>
      <button onClick={() => void state.retryFailedImages()}>fixture-retry</button>
      <output>{state.phase}</output>
    </>
  )
}
describe('report generation enhancements', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('group_report_image_selection_mode', 'hot-first')
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getMessages: vi.fn(async () => messages),
        getGroupSnapshot: vi.fn(async () => null),
        saveReportPreferences: vi.fn(async (value) => value),
        writeAppLog: vi.fn(async () => undefined),
        imageListCandidates: vi.fn(async (query) => ({
          success: true,
          candidates: (query.inputs || []).map((input) => ({
            ...input,
            imageHash: input.md5,
            heatScore: 1
          }))
        })),
        getImage: vi.fn(async () => ({ success: true, data: 'data:image/png;base64,fixture' })),
        imageAnalyze: vi.fn(async (request: ImageAnalysisRequest) => ({
          success: true,
          insight: {
            ...request,
            id: request.messageId,
            description: 'fixture-description',
            tags: [],
            category: 'photo',
            importance: 'medium',
            provider: 'fixture-provider',
            model: 'fixture-vision',
            createdAt: Date.now(),
            updatedAt: Date.now()
          } as ImageInsight
        })),
        aiChat: vi.fn(async () => ({
          success: true,
          data: JSON.stringify({
            topics: [
              { title: 'fixture-topic', summary: 'fixture-summary', keywords: [], heat: '高' }
            ]
          })
        })),
        exportGroupReport: vi.fn(async () => ({
          success: true,
          imageDataUrl: 'data:image/png;base64,fixture',
          htmlPath: 'fixture.html',
          pngPath: 'fixture.png'
        }))
      }
    })
  })
  it('remembers selected report modules and saves the shared preference used by background reports', async () => {
    const view = render(<Harness />)
    fireEvent.click(screen.getByRole('checkbox', { name: '实用资源' }))
    await waitFor(() =>
      expect(window.api.saveReportPreferences).toHaveBeenLastCalledWith(
        expect.objectContaining({ sections: expect.not.arrayContaining(['resources']) })
      )
    )
    view.unmount()
    render(<Harness />)
    expect(screen.getByRole('checkbox', { name: '实用资源' })).not.toBeChecked()
  })
  it('previews local images and allows excluding an image without calling AI', async () => {
    render(<Harness />)
    await waitFor(() => expect(state.reportMessages).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: '预览并选择图片' }))
    await screen.findByRole('checkbox', { name: '选择图片 fixture-image-0' }, { timeout: 5000 })
    fireEvent.click(screen.getByRole('checkbox', { name: '选择图片 fixture-image-0' }))
    expect(state.selectedImageIds).toEqual(['fixture-image-1'])
    expect(window.api.imageAnalyze).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '恢复自动选图' }))
    expect(state.selectedImageIds).toBeUndefined()
  })
  it('pauses after an image failure and retries only the failed recognition before completing', async () => {
    const analyze = vi.mocked(window.api.imageAnalyze)
    analyze.mockResolvedValueOnce({ success: false, error: 'fixture-transient' })
    render(<Harness />)
    await waitFor(() => expect(state.rangeState.status).toBe('success'))
    await act(async () => {
      await state.generate()
    })
    expect(state.phase).toBe('awaitingImageDecision')
    expect(analyze).toHaveBeenCalledTimes(2)
    await act(async () => {
      await state.retryFailedImages()
    })
    expect(analyze).toHaveBeenCalledTimes(3)
    expect(state.imageInsightSummary).toMatchObject({ succeeded: 2, failed: 0 })
    expect(state.phase).toBe('success')
  })
  it('enables custom range inputs and sends edited start/end values back to the controller', () => {
    const onChange = vi.fn()
    render(
      <ReportRangeSelector
        value="custom"
        disabled={false}
        messageCount={0}
        rangeState={{ status: 'idle', error: '' }}
        onChange={vi.fn()}
        customRange={{ start: '', end: '' }}
        onCustomRangeChange={onChange}
      />
    )
    fireEvent.change(screen.getByLabelText('日报开始时间'), {
      target: { value: '2026-10-01T09:00' }
    })
    expect(onChange).toHaveBeenCalledWith({ start: '2026-10-01T09:00', end: '' })
  })

  it.each([false, true])(
    'retries long records with model change %s and reuses only compatible summaries',
    async (changeModel) => {
      vi.mocked(window.api.getMessages).mockResolvedValue(
        Array.from({ length: 6 }, (_, index) => ({
          ...messages[0],
          id: `fixture-long-${index}`,
          type: '普通文本',
          content: '示例讨论。'.repeat(1_600),
          contentData: { type: 'text', content: '示例讨论。'.repeat(1_600) }
        }))
      )
      const chat = vi.mocked(window.api.aiChat)
      const reportReply = {
        success: true,
        data: JSON.stringify({
          topics: [{ title: 'fixture', summary: 'fixture', keywords: [], heat: '高' }]
        })
      }
      let summaries = 0
      let fail = true
      chat.mockImplementation(async (input) => {
        if (input[0].content.includes('证据整理员')) {
          summaries++
          if (summaries === 2 && fail) return { success: false, error: 'fixture-transient' }
          return { success: true, data: '[fixture-long-0] 2026-10-01 示例成员确认需求' }
        }
        return reportReply
      })
      render(<Harness messageTypes={['text']} />)
      await waitFor(() => expect(state.rangeState.status).toBe('success'))
      await act(async () => {
        await state.generate()
      })
      expect(state.phase).toBe('error')
      expect(window.api.exportGroupReport).not.toHaveBeenCalled()
      expect(summaries).toBe(2)
      fail = false
      await act(async () => {
        await state.retry(changeModel ? { ...model, model: 'fixture-second' } : undefined)
      })
      expect(state.phase).toBe('success')
      expect(state.reportMetadata?.longRecordSummary?.chunks).toBeGreaterThan(1)
      expect(
        chat.mock.calls.filter(([input]) => input[1].content.includes('分段总结 1/'))
      ).toHaveLength(changeModel ? 2 : 1)
    }
  )
})
