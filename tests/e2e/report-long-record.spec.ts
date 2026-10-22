import { expect, test } from '@playwright/test'
import { launchTestApp } from './support/electron'

test('long report shows chunk progress, resumes a failure, and saves complete-count metadata', async () => {
  const fixture = await launchTestApp({ now: Date.parse('2026-10-22T12:00:00+08:00') })
  const errors: string[] = []
  fixture.page.on('pageerror', (error) => errors.push(error.message))
  try {
    await fixture.app.evaluate(({ ipcMain }) => {
      const state = {
        calls: [] as { input: string; model?: string }[],
        firstSummary: 0,
        failed: false
      }
      Object.assign(globalThis, { fixtureLongReport: state })
      ipcMain.removeHandler('db:getMessages')
      ipcMain.handle('db:getMessages', () =>
        Array.from({ length: 6 }, (_, index) => ({
          id: `fixture-long-${index}`,
          from: 'fixture-member',
          name: '示例成员',
          senderId: 'wxid_fixture_member',
          type: '普通文本',
          datetime: `2026-10-22 10:0${index}:00`,
          isSender: false,
          content: '示例长记录讨论。'.repeat(1_200),
          contentData: { type: 'text', content: '示例长记录讨论。'.repeat(1_200) }
        }))
      )
      ipcMain.removeHandler('ai:chat')
      ipcMain.handle('ai:chat', async (_, messages, options) => {
        const input = String(messages[1]?.content || '')
        state.calls.push({ input, model: options?.modelId })
        if (String(messages[0]?.content).includes('证据整理员')) {
          if (input.includes('总结 1/')) state.firstSummary++
          if (input.includes('总结 2/') && !state.failed) {
            state.failed = true
            return { success: false, error: 'fixture分段服务暂不可用' }
          }
          // Enough time for the rendered progress to be observable.
          await new Promise((resolve) => setTimeout(resolve, 450))
          return {
            success: true,
            data: '[fixture-long-5] 2026-10-22 示例成员确认下周需求',
            usage: { input: 10, output: 5, total: 15 }
          }
        }
        return {
          success: true,
          data: JSON.stringify({
            overview: 'fixture-long-report',
            topics: [
              {
                title: 'fixture需求确认',
                summary: '示例成员确认下周需求',
                keywords: [],
                heat: '高',
                sourceMessageIds: ['fixture-long-5']
              }
            ]
          }),
          usage: { input: 10, output: 5, total: 15 }
        }
      })
    })
    const page = fixture.page
    await page.getByRole('button', { name: '日报', exact: true }).click()
    await page.getByRole('button', { name: '开始生成日报', exact: true }).click()
    await page.locator('.report-source-item').filter({ hasText: '产品测试群' }).click()
    await expect(page.getByText('6 条消息', { exact: true })).toBeVisible()
    await expect(page.getByText(/长记录会自动分段总结后汇总/)).toBeVisible()
    await page.getByRole('button', { name: '开始生成日报', exact: true }).click()
    await expect(page.locator('.report-task-panel')).toContainText('fixture分段服务暂不可用')
    const retry = page.getByRole('button', { name: '使用所选模型重新生成', exact: true })
    await retry.click()
    await expect(page.locator('.report-preparation-progress')).toContainText(/长记录分段总结/)
    if (process.env.WXE_QA_LONG_RECORD_SCREENSHOT)
      await page.screenshot({ path: process.env.WXE_QA_LONG_RECORD_SCREENSHOT })
    await expect
      .poll(async () =>
        page.evaluate(
          async () =>
            (await window.api.listGeneratedReports()).reports?.[0]?.reportMetadata
              ?.longRecordSummary?.chunks || 0
        )
      )
      .toBeGreaterThan(1)
    const metadata = await page.evaluate(
      async () => (await window.api.listGeneratedReports()).reports?.[0]?.reportMetadata
    )
    expect(metadata?.messageCount).toBe(6)
    expect(metadata?.recordNote).toContain('压缩可能省略细节')
    const state = await fixture.app.evaluate(
      () =>
        (
          globalThis as unknown as {
            fixtureLongReport: { firstSummary: number; calls: { input: string }[] }
          }
        ).fixtureLongReport
    )
    expect(state.firstSummary).toBe(1)
    expect(state.calls.at(-1)?.input).toContain('证据段')
    expect(errors).toEqual([])
  } finally {
    await fixture.close()
  }
})
