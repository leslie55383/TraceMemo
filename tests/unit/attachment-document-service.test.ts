import { describe, expect, it } from 'vitest'
import {
  runAttachmentProcess,
  AttachmentDocumentService
} from '../../src/main/attachments/attachment-document-service'

describe('attachment subprocess boundary', () => {
  it('stops a pending file choice when the connected account changes', async () => {
    let account = 'account-a'
    const source = {
      conversationId: 'group',
      messageId: 'local:7',
      createTime: 100,
      fileName: 'file.pdf',
      sender: '成员'
    }
    const service = new AttachmentDocumentService({
      root: '/missing-fixture-runtime',
      accountId: () => account,
      resolveSource: async () => source,
      chooseFile: async () => {
        account = 'account-b'
        return '/synthetic.pdf'
      }
    })
    expect(await service.parse(source)).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('账号已切换')
    })
  })
  it('preserves JSON UTF-8 across byte boundaries and never interprets input as shell code', async () => {
    const script = `let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',s=>input+=s); process.stdin.on('end',()=>{const out=Buffer.from(JSON.stringify({success:true,result:JSON.parse(input)})); for(let i=0;i<out.length;i++)setTimeout(()=>process.stdout.write(out.subarray(i,i+1)),i)})`
    const input = { text: '中文📎 $(whoami) `literal` & |', path: 'file with spaces' }
    expect(await runAttachmentProcess(process.execPath, ['-e', script], input)).toEqual(input)
  })
  it('rejects failed installers even when stdout is nonempty', async () => {
    await expect(
      runAttachmentProcess(process.execPath, [
        '-e',
        `console.log('partial install');process.exitCode=2`
      ])
    ).rejects.toThrow('进程退出')
  })
  it('waits for cancellation and timeout process closure', async () => {
    const controller = new AbortController()
    const job = runAttachmentProcess(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      {},
      { signal: controller.signal }
    )
    controller.abort()
    await expect(job).rejects.toThrow()
    await expect(
      runAttachmentProcess(
        process.execPath,
        ['-e', 'setInterval(()=>{},1000)'],
        {},
        { timeoutMs: 30 }
      )
    ).rejects.toThrow('超时')
  })
  it('reports missing runtime and never reads attachments without a connected account', async () => {
    const service = new AttachmentDocumentService({
      root: '/missing-fixture-runtime',
      accountId: () => '',
      resolveSource: async () => {
        throw new Error('should not resolve without account')
      },
      chooseFile: async () => undefined
    })
    expect((await service.runtimeStatus()).ready).toBe(false)
    expect(await service.search({ text: '预算', terms: ['预算'] })).toEqual({ evidence: [] })
    await expect(
      service.status({ conversationId: 'group', messageId: '1', createTime: 1 })
    ).rejects.toThrow('连接微信')
  })
})
