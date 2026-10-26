import { spawn } from 'child_process'
import { existsSync, promises as fs } from 'fs'
import { join, extname } from 'path'
import { homedir } from 'os'
import type { KnowledgeSearchIpcRequest } from '../../shared/knowledge'
import type {
  AttachmentDocument,
  AttachmentExcerptRequest,
  AttachmentExcerptResult,
  AttachmentReference,
  AttachmentSource,
  AttachmentStatus,
  AttachmentSearchResult,
  DoclingRuntimeStatus
} from '../../shared/attachment-document'
import { DOCLING_VERSION, DOCLING_OCR_VERSION } from '../../shared/attachment-document'
import bridge from './docling-bridge.py?raw'

export interface AttachmentServiceDependencies {
  root: string
  accountId: () => string
  resolveSource: (ref: AttachmentReference) => Promise<AttachmentSource>
  chooseFile: (source: AttachmentSource) => Promise<string | undefined>
}

/** Only launches our fixed bridge. User input is JSON on stdin, never shell source. */
export function runAttachmentProcess(
  executable: string,
  args: string[],
  input?: unknown,
  options: { timeoutMs?: number; signal?: AbortSignal; offline?: boolean } = {}
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      signal: options.signal,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        HF_HUB_DISABLE_TELEMETRY: '1',
        DO_NOT_TRACK: '1',
        ...(options.offline ? { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } : {})
      }
    })
    let output = ''
    let settled = false
    let failure: Error | undefined
    const stop = (error: Error): void => {
      failure ||= error
      child.kill()
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        reject(error)
        return
      }
      if (input === undefined) {
        resolve(undefined)
        return
      }
      try {
        const response = JSON.parse(output)
        if (!response.success) throw new Error(response.error || '附件处理失败')
        resolve(response.result)
      } catch (parseError) {
        reject(parseError instanceof Error ? parseError : new Error('附件处理返回无效结果'))
      }
    }
    const timer = setTimeout(
      () => stop(new Error('附件处理超时；请拆分文件，或检查环境与模型下载')),
      options.timeoutMs || 180_000
    )
    child.on('error', (error) => {
      failure ||= error
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (data: string) => {
      output += data
      if (output.length > 12_000_000) stop(new Error('附件处理结果过大，已停止'))
    })
    // Drain parser/model progress; do not put document content or local paths in application logs.
    child.stderr.on('data', () => undefined)
    child.on('close', (code) =>
      finish(
        failure || (code !== 0 ? new Error('附件处理进程退出；请检查 Docling 环境') : undefined)
      )
    )
    child.stdin.on('error', () => undefined)
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input))
  })
}

export class AttachmentDocumentService {
  private runtimeAbort?: AbortController
  dispose(): void {
    this.cancelAll()
    this.runtimeAbort?.abort()
  }
  cancelAll(): void {
    for (const job of this.jobs.values()) job.abort()
  }
  private clearing = false
  private readonly processes = new Set<Promise<unknown>>()
  async clearIndexes(): Promise<void> {
    this.clearing = true
    try {
      this.cancelAll()
      await Promise.allSettled([...this.processes])
      await fs.rm(join(this.dependencies.root, 'attachment-text'), { recursive: true, force: true })
      this.errors.clear()
    } finally {
      this.clearing = false
    }
  }
  private preparing = false
  private readonly jobs = new Map<string, AbortController>()
  private readonly errors = new Map<string, string>()
  private readonly python: string
  private readonly models: string
  constructor(private readonly dependencies: AttachmentServiceDependencies) {
    this.python =
      process.env.WXE_DOCLING_PYTHON ||
      join(
        dependencies.root,
        'docling',
        'venv',
        process.platform === 'win32' ? 'Scripts' : 'bin',
        process.platform === 'win32' ? 'python.exe' : 'python'
      )
    this.models = join(dependencies.root, 'docling', 'models')
  }
  private key(
    account: string,
    ref: Pick<AttachmentReference, 'conversationId' | 'messageId'>
  ): string {
    return JSON.stringify([account, ref.conversationId, ref.messageId])
  }
  private account(): string {
    const account = this.dependencies.accountId()
    if (!account) throw new Error('请先连接微信数据库')
    return account
  }
  private async run<T>(
    op: string,
    payload: object = {},
    accountId?: string,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.clearing) throw new Error('附件正文索引正在清理，请稍后重试')
    if (!existsSync(this.python)) throw new Error('Docling 环境尚未准备，请点击“准备本地解析环境”')
    const task = runAttachmentProcess(
      this.python,
      ['-u', '-c', bridge],
      {
        ...payload,
        op,
        root: this.dependencies.root,
        models: this.models,
        accountId
      },
      {
        timeoutMs: op === 'prepare' ? 20 * 60_000 : op === 'parse' ? 5 * 60_000 : 30_000,
        signal,
        offline: op !== 'prepare'
      }
    )
    if (accountId) this.processes.add(task)
    try {
      const result = (await task) as T
      if (accountId && this.dependencies.accountId() !== accountId)
        throw new Error('微信账号已切换，已停止返回上个账号的数据')
      return result
    } finally {
      this.processes.delete(task)
    }
  }
  async runtimeStatus(): Promise<DoclingRuntimeStatus> {
    try {
      return { ...(await this.run<DoclingRuntimeStatus>('probe')), preparing: this.preparing }
    } catch (error) {
      return {
        ready: false,
        pdfReady: false,
        preparing: this.preparing,
        error: String(error instanceof Error ? error.message : error)
      }
    }
  }
  async prepareRuntime(): Promise<DoclingRuntimeStatus> {
    if (this.preparing) return this.runtimeStatus()
    if (this.jobs.size) throw new Error('请先等待或取消附件解析')
    this.preparing = true
    const controller = new AbortController()
    this.runtimeAbort = controller
    try {
      const localUv = join(
        homedir(),
        '.local',
        'bin',
        process.platform === 'win32' ? 'uv.exe' : 'uv'
      )
      const uv = process.env.WXE_UV_EXECUTABLE || (existsSync(localUv) ? localUv : 'uv')
      if (!existsSync(this.python)) {
        await runAttachmentProcess(
          uv,
          ['venv', '--python', '3.12', join(this.dependencies.root, 'docling', 'venv')],
          undefined,
          { timeoutMs: 5 * 60_000, signal: controller.signal }
        )
      }
      await runAttachmentProcess(
        uv,
        [
          'pip',
          'install',
          '--python',
          this.python,
          `docling==${DOCLING_VERSION}`,
          `onnxruntime==${DOCLING_OCR_VERSION}`,
          '--extra-index-url',
          'https://download.pytorch.org/whl/cpu',
          '--index-strategy',
          'unsafe-best-match'
        ],
        undefined,
        { timeoutMs: 20 * 60_000, signal: controller.signal }
      )
      return await this.run<DoclingRuntimeStatus>('prepare', {}, undefined, controller.signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
        throw new Error('未找到 uv，请先安装 uv 并重启 TraceMemo，再准备解析环境')
      throw error
    } finally {
      this.preparing = false
      this.runtimeAbort = undefined
    }
  }
  async status(ref: AttachmentReference): Promise<AttachmentStatus> {
    const account = this.account()
    const source = await this.dependencies.resolveSource(ref)
    if (this.dependencies.accountId() !== account) throw new Error('微信账号已切换，请重试')
    const key = this.key(account, source)
    if (this.jobs.has(key)) return { state: 'parsing', fileName: source.fileName }
    if (this.errors.has(key))
      return { state: 'failed', fileName: source.fileName, error: this.errors.get(key) }
    if (!existsSync(this.python)) return { state: 'unparsed', fileName: source.fileName }
    return this.run('status', { source }, account)
  }
  async parse(ref: AttachmentReference): Promise<AttachmentStatus> {
    const account = this.account()
    const source = await this.dependencies.resolveSource(ref)
    if (this.dependencies.accountId() !== account) throw new Error('微信账号已切换，请重试')
    if (this.jobs.size || this.preparing) throw new Error('已有解析或环境准备任务，请稍后再试')
    const controller = new AbortController()
    const key = this.key(account, source)
    this.jobs.set(key, controller)
    this.errors.delete(key)
    try {
      const filePath = await this.dependencies.chooseFile(source)
      if (!filePath || controller.signal.aborted) return { state: 'unparsed', cancelled: true }
      if (this.dependencies.accountId() !== account)
        throw new Error('微信账号已切换，请重新选择文件')
      if (!['.pdf', '.docx', '.xlsx'].includes(extname(filePath).toLowerCase()))
        throw new Error('仅支持 PDF、DOCX、XLSX；旧版 DOC/XLS 请先另存为新格式')
      return await this.run('parse', { source, path: filePath }, account, controller.signal)
    } catch (error) {
      const message = controller.signal.aborted
        ? '解析已取消，请刷新查看索引状态'
        : error instanceof Error
          ? error.message
          : String(error)
      this.errors.set(key, message)
      if (this.errors.size > 200) this.errors.delete(this.errors.keys().next().value!)
      return { state: 'failed', fileName: source.fileName, error: message }
    } finally {
      this.jobs.delete(key)
    }
  }
  async cancel(ref: AttachmentReference): Promise<void> {
    const account = this.account()
    const source = await this.dependencies.resolveSource(ref)
    if (this.dependencies.accountId() !== account) throw new Error('微信账号已切换，请重试')
    this.jobs.get(this.key(account, source))?.abort()
  }
  async remove(ref: AttachmentReference): Promise<AttachmentStatus> {
    const account = this.account()
    const source = await this.dependencies.resolveSource(ref)
    if (this.dependencies.accountId() !== account) throw new Error('微信账号已切换，请重试')
    if (this.jobs.has(this.key(account, source))) throw new Error('请先取消或等待解析完成')
    const result = await this.run<AttachmentStatus>('delete', { source }, account)
    this.errors.delete(this.key(account, source))
    return result
  }
  async search(request: KnowledgeSearchIpcRequest): Promise<AttachmentSearchResult> {
    if (!existsSync(this.python) || !this.dependencies.accountId() || request.conversationBoundary)
      return { evidence: [] }
    return this.run('search', request, this.account())
  }
  async read(
    conversationId: string,
    messageIds: string[]
  ): Promise<{ documents: AttachmentDocument[] }> {
    if (!existsSync(this.python) || !messageIds.length) return { documents: [] }
    if (messageIds.length > 300) throw new Error('所选范围超过 300 条附件消息，请缩小范围')
    return this.run('read', { conversationId, messageIds }, this.account())
  }
  async readExcerpts(request: AttachmentExcerptRequest): Promise<AttachmentExcerptResult> {
    if (!existsSync(this.python) || !request.references.length) return { documents: [] }
    if (request.references.length > 200) throw new Error('一次最多读取 200 条附件消息')
    return this.run('readExcerpts', request, this.account())
  }
}
