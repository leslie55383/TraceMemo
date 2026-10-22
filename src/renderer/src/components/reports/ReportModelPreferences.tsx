import React, { useEffect, useState } from 'react'
import type { AIProviderSummary } from '../../../../shared/ai-provider'
import type { ReportPreferences } from '../../../../shared/report-preferences'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui'

export function ReportModelPreferences({
  value,
  onChange,
  disabled
}: {
  value: ReportPreferences
  onChange: (value: ReportPreferences) => void
  disabled?: boolean
}): React.ReactElement {
  const [providers, setProviders] = useState<AIProviderSummary[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void window.api
      .listAIProviders()
      .then((result) => {
        if (active) {
          setProviders(result.providers || [])
          if (!result.success) setError(result.error || '读取模型失败')
        }
      })
      .catch(() => {
        if (active) setError('读取模型失败')
      })
    return () => {
      active = false
    }
  }, [])
  return (
    <section className="report-config-section">
      <h3>规则使用的模型</h3>
      {(['textModel', 'visionModel'] as const).map((key) => {
        const selected = value[key]
        const selectedKey = selected ? JSON.stringify(selected) : 'default'
        const choices = providers.flatMap((provider) =>
          provider.models
            .filter((model) =>
              key === 'textModel' ? model.capabilities.chat : model.capabilities.vision
            )
            .map((model) => ({
              key: JSON.stringify({ providerId: provider.id, model: model.id }),
              label: `${provider.name} · ${model.name || model.id}`
            }))
        )
        return (
          <label className="block mt-3" key={key}>
            {key === 'textModel' ? '文字总结模型' : '图片理解模型'}
            <Select
              value={selectedKey}
              disabled={disabled}
              onValueChange={(choice) =>
                onChange({ ...value, [key]: choice === 'default' ? undefined : JSON.parse(choice) })
              }
            >
              <SelectTrigger
                aria-label={`规则${key === 'textModel' ? '文字总结模型' : '图片理解模型'}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">使用自动默认模型</SelectItem>
                {selected && !choices.some((choice) => choice.key === selectedKey) && (
                  <SelectItem value={selectedKey}>
                    已保存：{selected.model}（请检查可用性）
                  </SelectItem>
                )}
                {choices.map((choice) => (
                  <SelectItem key={choice.key} value={choice.key}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        )
      })}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
