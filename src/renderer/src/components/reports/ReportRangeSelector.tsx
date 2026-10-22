import React from 'react'
import { SUMMARY_DATE_OPTIONS, SummaryDateRange } from '../../utils/group-report'
import { RangeMessageState } from '../../hooks/useGroupReportGeneration'
import { SegmentedControl, SegmentedControlItem } from '../ui'
import { Input } from '../ui'
import type { CustomReportRange } from '../../../../shared/report-date-range'

interface ReportRangeSelectorProps {
  value: SummaryDateRange
  messageCount: number
  rangeState: RangeMessageState
  disabled: boolean
  onChange: (value: SummaryDateRange) => void
  customRange?: CustomReportRange
  onCustomRangeChange?: (value: CustomReportRange) => void
}

export function ReportRangeSelector({
  value,
  messageCount,
  rangeState,
  disabled,
  onChange,
  customRange = { start: '', end: '' },
  onCustomRangeChange
}: ReportRangeSelectorProps): React.ReactElement {
  const countText =
    rangeState.status === 'loading'
      ? '正在计算'
      : rangeState.status === 'error'
        ? rangeState.error
        : `${messageCount} 条消息`

  return (
    <section className="report-config-section">
      <div className="report-section-heading">
        <h3>总结范围</h3>
        <span className={rangeState.status === 'error' ? 'danger' : ''}>{countText}</span>
      </div>
      <SegmentedControl
        className="report-range-options w-full"
        aria-label="总结范围"
        value={value}
        disabled={disabled}
        onValueChange={(nextValue) => onChange(nextValue as SummaryDateRange)}
      >
        {SUMMARY_DATE_OPTIONS.map((option) => (
          <SegmentedControlItem
            key={option.value}
            className="h-auto min-h-10 whitespace-normal px-2 py-1.5 text-center"
            value={option.value}
          >
            {option.label}
          </SegmentedControlItem>
        ))}
        <SegmentedControlItem
          className="h-auto min-h-10 flex-col gap-0 whitespace-normal px-2 py-1.5 text-center"
          value="custom"
          disabled={disabled || !onCustomRangeChange}
        >
          自定义
        </SegmentedControlItem>
      </SegmentedControl>
      <p className="text-xs text-muted-foreground mt-2">
        长记录会自动分段总结后汇总，增加模型调用与耗时；内容过多时可缩小范围或增加日报超时。
      </p>
      {value === 'custom' && onCustomRangeChange && (
        <div className="grid grid-cols-2 gap-3 mt-3">
          <label>
            开始时间
            <Input
              aria-label="日报开始时间"
              type="datetime-local"
              value={customRange.start}
              disabled={disabled}
              onChange={(event) =>
                onCustomRangeChange({ ...customRange, start: event.target.value })
              }
            />
          </label>
          <label>
            结束时间
            <Input
              aria-label="日报结束时间"
              type="datetime-local"
              value={customRange.end}
              disabled={disabled}
              onChange={(event) => onCustomRangeChange({ ...customRange, end: event.target.value })}
            />
          </label>
        </div>
      )}
    </section>
  )
}
