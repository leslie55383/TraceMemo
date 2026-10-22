import React from 'react'
import {
  MAX_REPORT_IMAGE_LIMIT,
  type ReportImageSelectionMode
} from '../../../../shared/image-insight'
import {
  Checkbox,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui'
import type { ReportImageMethod } from '../../../../shared/report-preferences'

export function ReportImageSettings({
  limit,
  selectionMode,
  disabled,
  onLimitChange,
  onSelectionModeChange,
  method = 'vision',
  onMethodChange
}: {
  limit: number
  selectionMode: ReportImageSelectionMode
  disabled?: boolean
  onLimitChange: (value: number) => void
  onSelectionModeChange: (value: ReportImageSelectionMode) => void
  method?: ReportImageMethod
  onMethodChange?: (method: ReportImageMethod) => void
}): React.ReactElement {
  return (
    <section className="report-config-section">
      <div className="report-section-heading">
        <h3>日报图片识别</h3>
      </div>
      <label className="flex items-center justify-between gap-3">
        <span>单份日报最多识别图片数</span>
        <Input
          className="w-24"
          type="number"
          min={0}
          max={MAX_REPORT_IMAGE_LIMIT}
          step={1}
          value={limit}
          disabled={disabled}
          onChange={(event) => onLimitChange(Number(event.target.value))}
        />
      </label>
      <p className="report-section-desc">
        默认 3 张，最多 {MAX_REPORT_IMAGE_LIMIT} 张；0
        表示关闭。识别更多图片会增加模型用量和等待时间。
      </p>
      <label className="mt-3 flex items-center gap-2">
        <Checkbox
          checked={selectionMode === 'hot-first'}
          disabled={disabled || limit === 0}
          onCheckedChange={(checked) =>
            onSelectionModeChange(checked === true ? 'hot-first' : 'hot-only')
          }
        />
        <span>热点图片不足时补入普通图片</span>
      </label>
      <p className="report-section-desc">
        优先选择有讨论的图片；开启后，无人回复的截图、公告图也可参与识别。
      </p>
      {onMethodChange && (
        <div className="mt-3">
          <label>图片处理方式</label>
          <Select
            value={method}
            disabled={disabled || limit === 0}
            onValueChange={(value) => onMethodChange(value as ReportImageMethod)}
          >
            <SelectTrigger aria-label="图片处理方式">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="vision">视觉模型理解图片</SelectItem>
              <SelectItem value="ocr-only">仅本地 OCR 提取文字</SelectItem>
              <SelectItem value="ocr-first">本地 OCR 优先，无文字时调用视觉模型</SelectItem>
            </SelectContent>
          </Select>
          <p className="report-section-desc">
            本地 OCR 只提取文字，不理解图意。识别文字会交给当前文字模型总结；OCR
            优先模式在无结果时可能上传原图至视觉模型。
          </p>
        </div>
      )}
    </section>
  )
}
