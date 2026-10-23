import { expect, test } from '@playwright/test'
import { launchTestApp } from './support/electron'

test('attachment parsing states, report input and index deletion work in the desktop UI', async () => {
  test.setTimeout(90_000)
  const fixture = await launchTestApp({ now: Date.parse('2026-10-23T12:00:00+08:00') })
  const errors: string[] = []
  fixture.page.on('pageerror', (error) => errors.push(error.message))
  fixture.page.on('console', (item) => {
    if (item.type() === 'error') errors.push(item.text())
  })
  try {
    await fixture.app.evaluate(({ ipcMain }) => {
      let ready = false
      let indexed = false
      let attempts = 0
      const source = {
        conversationId: 'group-regular-md5',
        messageId: 'local:7',
        fileName: '测试项目预算.xlsx',
        sender: '测试成员',
        createTime: 1792720800
      }
      const body = {
        source,
        parts: [{ location: '工作表：预算', text: '研发预算24680元，验收在十一月。' }],
        engine: 'fixture',
        parsedAt: 1
      }
      const state = { prompts: [] as string[], parseReferences: [] as unknown[] }
      Object.assign(globalThis, { fixtureAttachment: state })
      const replace = (channel: string, handler: (...args: any[]) => unknown): void => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, (_, ...args) => handler(...args))
      }
      replace('db:getMessages', () => [
        {
          id: 'raw-file',
          localId: 7,
          from: 'user',
          name: '测试成员',
          type: '文件',
          datetime: '2026-10-23 10:00:00',
          createTime: source.createTime,
          content: '[文件]测试项目预算.xlsx',
          isSender: false,
          contentData: { type: 'share', typeVal: '6', title: '测试项目预算.xlsx', url: '' }
        }
      ])
      replace('attachment:runtime', () => ({ ready, pdfReady: ready, preparing: false }))
      replace('attachment:prepare', () => {
        ready = true
        return { ready, pdfReady: true, preparing: false }
      })
      replace('attachment:status', () => ({
        state: indexed ? 'indexed' : attempts === 1 ? 'failed' : 'unparsed',
        error: attempts === 1 ? '测试文件损坏，请重新选择' : undefined
      }))
      replace('attachment:parse', async (ref) => {
        state.parseReferences.push(ref)
        attempts++
        if (attempts === 1) return { state: 'failed', error: '测试文件损坏，请重新选择' }
        indexed = true
        return { state: 'indexed', partCount: 1 }
      })
      replace('attachment:read', (request) => ({
        documents: indexed && request.messageIds.includes('local:7') ? [body] : []
      }))
      replace('attachment:remove', () => {
        indexed = false
        return { state: 'unparsed' }
      })
      replace('ai:chat', (messages) => {
        state.prompts.push(String(messages[1]?.content || ''))
        return {
          success: true,
          data: JSON.stringify({
            overview: '附件预算确认',
            topics: [
              {
                title: '附件预算',
                summary: '测试附件中的研发预算为24680元',
                heat: '中',
                keywords: [],
                sourceMessageIds: ['raw-file']
              }
            ],
            resources: [
              {
                title: '测试项目预算.xlsx',
                description: '附件预算24680元',
                sender: '测试成员',
                sourceMessageIds: ['raw-file']
              }
            ]
          })
        }
      })
    })
    const page = fixture.page
    await page
      .locator('.conversation-item-name')
      .filter({ hasText: /^产品测试群$/ })
      .click()
    await expect(page.getByRole('heading', { name: '产品测试群' })).toBeVisible()
    await page.getByRole('button', { name: /附件正文/ }).click()
    await expect(page.getByText(/命中的正文会发送/)).toBeVisible()
    await page.getByRole('button', { name: '准备本地解析环境' }).click()
    const parse = page.getByRole('button', { name: '选择本地附件并解析' })
    await expect(parse).toBeEnabled()
    await parse.click()
    await expect(page.getByRole('alert')).toContainText('测试文件损坏')
    await parse.click()
    await expect(page.getByRole('status')).toContainText('正文已加入搜索和日报')
    if (process.env.WXE_QA_ATTACHMENT_SCREENSHOT)
      await page.screenshot({ path: process.env.WXE_QA_ATTACHMENT_SCREENSHOT })
    await page.getByRole('button', { name: '日报', exact: true }).click()
    await page.getByRole('button', { name: '开始生成日报', exact: true }).click()
    await page.locator('.report-source-item').filter({ hasText: '产品测试群' }).click()
    await page.getByRole('checkbox', { name: '文件', exact: true }).check()
    await page.getByRole('button', { name: '开始生成日报', exact: true }).click()
    await expect
      .poll(async () =>
        page.evaluate(
          async () =>
            (await window.api.listGeneratedReports()).reports?.[0]?.reportMetadata?.recordNote || ''
        )
      )
      .toContain('附件正文 1/1')
    const state = await fixture.app.evaluate(
      () =>
        (
          globalThis as unknown as {
            fixtureAttachment: { prompts: string[]; parseReferences: unknown[] }
          }
        ).fixtureAttachment
    )
    expect(state.prompts.join('\n')).toContain('24680')
    expect(state.prompts.join('\n')).toContain('工作表：预算')
    expect(state.parseReferences).toHaveLength(2)
    await page.getByRole('button', { name: '档案', exact: true }).click()
    await page
      .locator('.conversation-item-name')
      .filter({ hasText: /^产品测试群$/ })
      .click()
    const toggle = page.getByRole('button', { name: /附件正文/ })
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
    await page.getByRole('button', { name: '删除正文索引' }).click()
    await expect(page.getByRole('status')).toContainText('尚未解析')
    expect(errors).toEqual([])
  } finally {
    await fixture.close()
  }
})
