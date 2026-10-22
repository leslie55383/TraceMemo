import { expect, test } from '@playwright/test'
import { launchTestApp } from './support/electron'

test('report image settings can be edited, survive reload, and disable image recognition', async () => {
  const fixture = await launchTestApp()
  const errors: string[] = []
  fixture.page.on('pageerror', (error) => errors.push(error.message))
  fixture.page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const openReport = async (): Promise<void> => {
    await fixture.page.getByRole('button', { name: '日报', exact: true }).click()
    await fixture.page.getByRole('button', { name: '开始生成日报', exact: true }).click()
    await expect(fixture.page.getByRole('heading', { name: '生成群聊日报' })).toBeVisible()
  }
  try {
    await openReport()
    const limit = fixture.page.getByRole('spinbutton', { name: '单份日报最多识别图片数' })
    const ordinary = fixture.page.getByRole('checkbox', { name: '热点图片不足时补入普通图片' })
    await expect(limit).toHaveValue('3')
    await limit.fill('10')
    await ordinary.check()
    await fixture.page.reload()
    await openReport()
    await expect(limit).toHaveValue('10')
    await expect(ordinary).toBeChecked()
    await limit.scrollIntoViewIfNeeded()
    if (process.env.WXE_QA_SCREENSHOT) {
      await fixture.page.screenshot({ path: process.env.WXE_QA_SCREENSHOT })
    }
    await limit.fill('0')
    await expect(ordinary).toBeDisabled()
    await limit.fill('10')
    await expect(ordinary).toBeEnabled()
    expect(errors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('explains why image messages are skipped in the rendered report workflow', async () => {
  const fixture = await launchTestApp()
  try {
    await fixture.app.evaluate(({ ipcMain }) => {
      // Keep the fixture at the model step so the task panel stays visible.
      ipcMain.removeHandler('ai:chat')
      ipcMain.handle('ai:chat', () => new Promise(() => {}))
      ipcMain.removeHandler('image:listCandidates')
      ipcMain.handle('image:listCandidates', (_, query) => ({
        success: true,
        candidates: [],
        selection: {
          inputCount: query.inputs.length,
          excludedByHotRule: query.inputs.length,
          unavailable: 0,
          duplicates: 0,
          excludedByLimit: 0,
          disabled: false
        }
      }))
    })
    await fixture.page.getByRole('button', { name: '日报', exact: true }).click()
    await fixture.page.getByRole('button', { name: '开始生成日报', exact: true }).click()
    await fixture.page.locator('.report-source-item').filter({ hasText: '产品测试群' }).click()
    await fixture.page.getByRole('checkbox', { name: '图片', exact: true }).check()
    await fixture.page.getByRole('button', { name: '开始生成日报', exact: true }).click()
    const coverage = fixture.page.getByLabel('日报图片筛选说明')
    await expect(coverage).toContainText('图片消息 1 条 · 本次选中 0 张')
    await expect(coverage).toContainText('未达热点条件 1 条；可开启普通图片补入。')
    if (process.env.WXE_QA_COVERAGE_SCREENSHOT) {
      await fixture.page.screenshot({ path: process.env.WXE_QA_COVERAGE_SCREENSHOT })
    }
  } finally {
    await fixture.close()
  }
})

test('custom dates, density and modules are editable and preferences survive reload', async () => {
  const fixture = await launchTestApp({ now: Date.parse('2026-10-21T12:00:00+08:00') })
  try {
    const page = fixture.page
    const openReport = async (): Promise<void> => {
      await page.getByRole('button', { name: '日报', exact: true }).click()
      await page.getByRole('button', { name: '开始生成日报', exact: true }).click()
      await page.locator('.report-source-item').filter({ hasText: '产品测试群' }).click()
    }
    await openReport()
    await page.getByText('自定义', { exact: true }).click()
    await page.getByLabel('日报开始时间').fill('2026-10-01T00:00')
    await page.getByLabel('日报结束时间').fill('2026-10-31T23:59')
    await expect(page.getByText('3 条消息', { exact: true })).toBeVisible()
    await page.getByRole('combobox', { name: '内容密度', exact: true }).click()
    await page.getByRole('option', { name: '详细', exact: true }).click()
    await page.getByRole('checkbox', { name: '关键词', exact: true }).uncheck()
    await page.getByRole('combobox', { name: '图片处理方式' }).click()
    await page.getByRole('option', { name: '仅本地 OCR 提取文字', exact: true }).click()
    await expect
      .poll(async () =>
        page.evaluate(async () => (await window.api.getReportPreferences()).density)
      )
      .toBe('detailed')
    await page.reload()
    await openReport()
    await expect(page.getByRole('combobox', { name: '内容密度', exact: true })).toHaveText('详细')
    await expect(page.getByRole('checkbox', { name: '关键词', exact: true })).not.toBeChecked()
    await expect(page.getByRole('combobox', { name: '图片处理方式' })).toHaveText(
      '仅本地 OCR 提取文字'
    )
  } finally {
    await fixture.close()
  }
})

test('previews a local image and generates an OCR report without remote vision calls', async () => {
  const fixture = await launchTestApp({ now: Date.parse('2026-10-21T12:00:00+08:00') })
  try {
    await fixture.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('image:listCandidates')
      ipcMain.handle('image:listCandidates', (_, query) => ({
        success: true,
        candidates: query.inputs
          .slice(0, query.limit)
          .map((input) => ({ ...input, imageHash: input.md5, heatScore: 1 }))
      }))
      ipcMain.removeHandler('system-ocr:recognize')
      ipcMain.handle('system-ocr:recognize', () => ({
        success: true,
        text: 'fixture公告：周五确认需求',
        lines: [],
        language: 'zh-Hans-CN',
        engine: 'windows-system-ocr',
        durationMs: 1
      }))
      ipcMain.removeHandler('image:analyze')
      ipcMain.handle('image:analyze', () => {
        throw new Error('OCR-only must not call remote vision')
      })
    })
    const page = fixture.page
    await page.getByRole('button', { name: '日报', exact: true }).click()
    await page.getByRole('button', { name: '开始生成日报', exact: true }).click()
    await page.locator('.report-source-item').filter({ hasText: '产品测试群' }).click()
    await page.getByRole('checkbox', { name: '图片', exact: true }).check()
    await page.getByRole('combobox', { name: '图片处理方式' }).click()
    await page.getByRole('option', { name: '仅本地 OCR 提取文字', exact: true }).click()
    await page.getByRole('button', { name: '预览并选择图片', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: '选择图片 msg-image' })).toBeChecked()
    await expect(page.getByAltText(/的图片预览$/)).toBeVisible()
    await page.getByRole('checkbox', { name: '选择图片 msg-image' }).scrollIntoViewIfNeeded()
    if (process.env.WXE_QA_PICKER_SCREENSHOT)
      await page.screenshot({ path: process.env.WXE_QA_PICKER_SCREENSHOT })
    await page.getByRole('button', { name: '开始生成日报', exact: true }).click()
    await expect
      .poll(async () =>
        page.evaluate(
          async () =>
            (await window.api.listGeneratedReports()).reports?.[0]?.reportMetadata?.footerNote || ''
        )
      )
      .toContain('本地 OCR 1 张')
    const record = await page.evaluate(
      async () => (await window.api.listGeneratedReports()).reports?.[0]
    )
    expect(record?.reportSnapshot?.media.visionGallery?.[0].ocrText).toContain('fixture公告')
    expect(record?.reportSnapshot?.media.visionGallery?.[0].source).toBe('local-ocr')
  } finally {
    await fixture.close()
  }
})
