import { useEffect, useState } from 'react'
import { Button } from '../ui/button'
import { markAttachmentIndexChanged } from '../../utils/attachment-index-cache'
import type { Contact, Message } from '../../../../shared/types'
import type {
  AttachmentReference,
  AttachmentStatus,
  DoclingRuntimeStatus
} from '../../../../shared/attachment-document'

const LABELS: Record<AttachmentStatus['state'], string> = {
  unparsed: '尚未解析',
  parsing: '正在本地解析…',
  indexed: '正文已加入搜索和日报',
  stale: '本地文件已变化或不可用，请重新选择解析',
  failed: '解析未完成'
}

export function AttachmentDocumentPanel({
  message,
  contact
}: {
  message: Message
  contact: Contact
}): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false)
  const [status, setStatus] = useState<AttachmentStatus>({ state: 'unparsed' })
  const [runtime, setRuntime] = useState<DoclingRuntimeStatus>()
  const [busy, setBusy] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState('')
  const data = message.contentData
  const supported =
    data?.type === 'share' && data.typeVal === '6' && /\.(pdf|docx|xlsx)$/i.test(data.title)
  const ref: AttachmentReference = {
    conversationId: contact.md5,
    messageId: message.id,
    createTime: message.createTime || Math.floor(Date.parse(message.datetime) / 1000)
  }
  const { conversationId, messageId, createTime } = ref
  useEffect(() => {
    if (!expanded || !supported) return
    let active = true
    const load = async (): Promise<void> => {
      try {
        const [nextRuntime, nextStatus] = await Promise.all([
          window.api.attachmentRuntimeStatus(),
          window.api.attachmentStatus({ conversationId, messageId, createTime })
        ])
        if (active) {
          setRuntime(nextRuntime)
          setStatus(nextStatus)
        }
      } catch (reason) {
        if (active) setError(String(reason instanceof Error ? reason.message : reason))
      }
    }
    void load()
    const timer = setInterval(() => {
      void load()
    }, 3000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [expanded, supported, conversationId, messageId, createTime])
  if (!supported) return null
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await operation()
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason))
    } finally {
      setBusy(false)
    }
  }
  const working = busy || status.state === 'parsing' || preparing || runtime?.preparing
  const canParse = runtime?.ready && (!/\.pdf$/i.test(data.title) || runtime.pdfReady)
  return (
    <div
      className="mt-2 max-w-sm rounded-lg border border-border-subtle bg-background px-3 py-2 text-xs"
      onClick={(event) => event.stopPropagation()}
    >
      <Button
        variant="link"
        size="sm"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        附件正文{expanded ? ' ▴' : ' ▾'}
      </Button>
      {expanded && (
        <div className="mt-2 grid max-w-sm gap-2 leading-relaxed">
          <p>
            选择已下载的原附件，在本机解析 PDF / Word（DOCX）/ Excel（XLSX）。索引按微信账号隔离。
          </p>
          <p className="text-muted-foreground">
            问答、日报使用远程模型时，命中的正文会发送给你配置的模型服务。仅解析你确认的文件。
          </p>
          <p role="status">
            {preparing || runtime?.preparing
              ? '正在下载本地解析环境和模型，首次准备可能需要数分钟…'
              : LABELS[status.state]}
            {status.partCount ? `（${status.partCount} 段）` : ''}
          </p>
          {(status.error || error) && (
            <p role="alert" className="text-destructive break-words">
              {error || status.error}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            {(!canParse || status.state === 'failed') && (
              <Button
                variant="outline"
                size="sm"
                disabled={!!working}
                onClick={() =>
                  void run(async () => {
                    setPreparing(true)
                    try {
                      setRuntime(await window.api.attachmentPrepareRuntime())
                    } finally {
                      setPreparing(false)
                    }
                  })
                }
              >
                {canParse ? '修复解析环境' : '准备本地解析环境'}
              </Button>
            )}
            <Button
              variant="default"
              size="sm"
              disabled={!canParse || !!working}
              onClick={() =>
                void run(async () => {
                  const result = await window.api.attachmentParse(ref)
                  setStatus(result)
                  if (result.state === 'indexed') markAttachmentIndexChanged()
                })
              }
            >
              {status.state === 'indexed' || status.state === 'stale'
                ? '重新选择并解析'
                : '选择本地附件并解析'}
            </Button>
            {(status.state === 'parsing' || (busy && !preparing)) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void window.api.attachmentCancel(ref).catch((reason) => setError(String(reason)))
                }
              >
                取消解析
              </Button>
            )}
            {['indexed', 'stale', 'failed'].includes(status.state) && (
              <Button
                variant="ghost"
                size="sm"
                disabled={!!working}
                onClick={() =>
                  void run(async () => {
                    setStatus(await window.api.attachmentRemove(ref))
                    markAttachmentIndexChanged()
                  })
                }
              >
                删除正文索引
              </Button>
            )}
          </div>
          <p className="text-muted-foreground">
            删除只移除本机正文索引；不会删除原附件。旧版 DOC / XLS 请先另存为新格式。
          </p>
        </div>
      )}
    </div>
  )
}
