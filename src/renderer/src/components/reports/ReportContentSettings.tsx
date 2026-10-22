import React from 'react'
import {
  REPORT_SECTION_OPTIONS,
  type ReportPreferences
} from '../../../../shared/report-preferences'
import { Checkbox, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui'

export function ReportContentSettings({
  value,
  onChange,
  disabled
}: {
  value: ReportPreferences
  onChange: (value: ReportPreferences) => void
  disabled?: boolean
}): React.ReactElement {
  return (
    <section className="report-config-section">
      <h3>日报内容与密度</h3>
      <label className="mt-3 block">
        内容密度
        <Select
          value={value.density}
          disabled={disabled}
          onValueChange={(density) =>
            onChange({ ...value, density: density as ReportPreferences['density'] })
          }
        >
          <SelectTrigger aria-label="内容密度">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="concise">简洁</SelectItem>
            <SelectItem value="standard">标准</SelectItem>
            <SelectItem value="detailed">详细</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <p className="report-section-desc">
        选择报告要展示的模块；未选择模块不会出现在导出报告中，概要始终保留。
      </p>
      <div className="grid grid-cols-2 gap-3 mt-3">
        {REPORT_SECTION_OPTIONS.map((option) => (
          <label key={option.value} className="flex items-center gap-2">
            <Checkbox
              aria-label={option.label}
              checked={value.sections.includes(option.value)}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onChange({
                  ...value,
                  sections: checked
                    ? [...value.sections, option.value]
                    : value.sections.filter((key) => key !== option.value)
                })
              }
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </section>
  )
}
