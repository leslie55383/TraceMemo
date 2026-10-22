import React, { useEffect, useRef, useState } from 'react'
import type { Contact, Message } from '../../../../shared/types'
import type { ReportImageSelectionMode } from '../../../../shared/image-insight'
import { loadReportImagePreviews, type ReportImagePreview } from '../../utils/report-image-preview'
import { Button, Checkbox } from '../ui'

export function ReportImagePicker({
  messages,
  contact,
  limit,
  mode,
  value,
  onChange,
  disabled
}: {
  messages: Message[]
  contact: Contact | null
  limit: number
  mode: ReportImageSelectionMode
  value?: string[]
  onChange: (ids: string[] | undefined) => void
  disabled?: boolean
}): React.ReactElement {
  const [images, setImages] = useState<ReportImagePreview[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const request = useRef(0)
  useEffect(() => {
    request.current++
    setImages([])
    setTotal(0)
    setLoading(false)
  }, [messages, limit, mode])
  useEffect(
    () => () => {
      request.current++
    },
    []
  )
  const load = async (nextPage: number): Promise<void> => {
    const id = ++request.current
    setLoading(true)
    setError('')
    try {
      const result = await loadReportImagePreviews(
        messages,
        contact,
        limit,
        mode,
        window.api,
        nextPage
      )
      if (id !== request.current) return
      setImages(result.images)
      setTotal(result.total)
      setPage(nextPage)
      if (!value) onChange(result.selectedIds)
    } catch (error) {
      if (id === request.current) setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (id === request.current) setLoading(false)
    }
  }
  return (
    <section className="report-config-section">
      <h3>图片预览与选择</h3>
      <p className="report-section-desc">
        预览只读取本机图片，不调用 AI。未预览时按规则自动选择；手动选择可补入普通图片，最多 {limit}{' '}
        条图片消息，重复图片在生成时合并。
      </p>
      <div className="flex gap-2 mt-3">
        <Button
          variant="outline"
          disabled={
            disabled ||
            loading ||
            limit === 0 ||
            !messages.some((m) => m.contentData?.type === 'image')
          }
          onClick={() => void load(0)}
        >
          {loading ? '正在读取图片' : '预览并选择图片'}
        </Button>
        {value && (
          <Button
            variant="ghost"
            disabled={disabled || loading}
            onClick={() => {
              onChange(undefined)
              setImages([])
              setTotal(0)
            }}
          >
            恢复自动选图
          </Button>
        )}
      </div>
      {value && <p>已选择 {value.length} 条图片消息</p>}
      {error && <p role="alert">{error}</p>}
      <div className="grid grid-cols-3 gap-3 mt-3">
        {images.map((image) => (
          <label key={image.id} className="min-w-0 rounded border p-2 text-xs">
            {image.url ? (
              <img
                className="h-24 w-full object-contain"
                src={image.url}
                alt={`${image.sender}的图片预览`}
              />
            ) : (
              <p className="h-24 overflow-hidden">{image.error}</p>
            )}
            <span className="block truncate">{image.sender}</span>
            <small>{image.time}</small>
            <small className="block">{image.reason}</small>
            <div className="flex items-center gap-1 mt-1">
              <Checkbox
                aria-label={`选择图片 ${image.id}`}
                checked={value?.includes(image.id) ?? image.selected}
                disabled={
                  disabled ||
                  loading ||
                  (!value?.includes(image.id) && (value?.length || 0) >= limit)
                }
                onCheckedChange={(checked) =>
                  onChange(
                    checked
                      ? [...(value || []), image.id]
                      : (value || []).filter((id) => id !== image.id)
                  )
                }
              />
              纳入识别
            </div>
          </label>
        ))}
      </div>
      {total > 24 && (
        <div className="flex items-center gap-2 mt-3">
          <Button disabled={disabled || loading || page === 0} onClick={() => void load(page - 1)}>
            上一页
          </Button>
          <span>
            {page + 1} / {Math.ceil(total / 24)}
          </span>
          <Button
            disabled={disabled || loading || (page + 1) * 24 >= total}
            onClick={() => void load(page + 1)}
          >
            下一页
          </Button>
        </div>
      )}
    </section>
  )
}
