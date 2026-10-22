import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { ReportImageSettings } from '../../src/renderer/src/components/reports/ReportImageSettings'
import { useGroupReportGeneration } from '../../src/renderer/src/hooks/useGroupReportGeneration'

function SettingsHarness({ disabled = false }: { disabled?: boolean }): React.ReactElement {
  const state = useGroupReportGeneration({
    sourceContact: null,
    summaryDateRange: 'today',
    summaryMessageTypes: ['text', 'image'],
    modelConfig: {
      configured: false,
      providerName: '',
      model: '',
      modelName: '',
      status: 'untested'
    }
  })
  return (
    <ReportImageSettings
      limit={state.reportImageLimit}
      selectionMode={state.reportImageSelectionMode}
      disabled={disabled}
      onLimitChange={state.setReportImageLimit}
      onSelectionModeChange={state.setReportImageSelectionMode}
    />
  )
}

describe('report image settings', () => {
  beforeEach(() => localStorage.clear())

  it('persists the image limit and ordinary-image selection across remounts', () => {
    const mounted = render(<SettingsHarness />)
    expect(screen.getByRole('spinbutton', { name: '单份日报最多识别图片数' })).toHaveValue(3)
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '热点图片不足时补入普通图片' }))
    mounted.unmount()
    render(<SettingsHarness />)
    expect(screen.getByRole('spinbutton')).toHaveValue(10)
    expect(screen.getByRole('checkbox')).toBeChecked()
  })

  it('clamps the limit to twenty and disables ordinary-image selection at zero', () => {
    render(<SettingsHarness />)
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '100' } })
    expect(screen.getByRole('spinbutton')).toHaveValue(20)
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0' } })
    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(localStorage.getItem('group_report_image_limit')).toBe('0')
  })

  it('locks both settings during generation', () => {
    render(<SettingsHarness disabled />)
    expect(screen.getByRole('spinbutton')).toBeDisabled()
    expect(screen.getByRole('checkbox')).toBeDisabled()
  })
})
