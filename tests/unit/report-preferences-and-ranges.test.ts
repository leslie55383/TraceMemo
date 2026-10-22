import { describe, expect, it } from 'vitest'
import {
  normalizeReportPreferences,
  validateReportPreferencePatch
} from '../../src/shared/report-preferences'
import { resolveReportDateRange } from '../../src/shared/report-date-range'
import { parseGroupDailyReport } from '../../src/renderer/src/utils/group-report'
import type { GroupReportMetadata } from '../../src/shared/group-report'
import { matchGroupReportIntent } from '../../src/main/services/agent-hub-routing'
import { normalizeScheduledReportConfig } from '../../src/shared/automation'
import { validateAutomationDraftShape } from '../../src/shared/agent-api/automation-validation'

describe('report preferences and calendar ranges', () => {
  it('validates the new scheduled preference fields without silently clamping API input', () => {
    const config = normalizeScheduledReportConfig({
      report: {
        sourceConversationId: 'fixture-group@chatroom',
        range: 'month',
        preferences: normalizeReportPreferences({ imageMethod: 'ocr-only' })
      }
    })
    const draft = {
      name: 'fixture-rule',
      enabled: false,
      ruleType: 'scheduled_report',
      scheduledReport: config
    }
    expect(validateAutomationDraftShape(draft).valid).toBe(true)
    config.report.preferences!.imageLimit = 21
    expect(validateAutomationDraftShape(draft).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'scheduledReport.report.preferences.imageLimit' })
      ])
    )
  })
  it('routes explicit current-week/month report commands without misreading previous periods', () => {
    expect(matchGroupReportIntent('请帮我生成产品测试群本周周报')).toEqual({
      group: '产品测试',
      range: 'week'
    })
    expect(matchGroupReportIntent('请帮我生成产品测试群本月月报')).toEqual({
      group: '产品测试',
      range: 'month'
    })
    expect(matchGroupReportIntent('请帮我生成产品测试群上周周报')).toBeNull()
  })
  it('rejects misspelled OCR modes and out-of-range API preferences', () => {
    expect(validateReportPreferencePatch({ imageMethod: 'ocr_only' })).not.toEqual([])
    expect(validateReportPreferencePatch({ imageLimit: 21 })).not.toEqual([])
    expect(validateReportPreferencePatch({ sections: ['unknown'] })).not.toEqual([])
    expect(
      validateReportPreferencePatch({ textModel: { providerId: '', model: 'fixture' } })
    ).not.toEqual([])
    expect(
      validateReportPreferencePatch(normalizeReportPreferences({ imageMethod: 'ocr-only' }))
    ).toEqual([])
  })
  it('uses local calendar week and month boundaries including leap day', () => {
    const now = new Date(2024, 1, 29, 14, 30)
    expect(resolveReportDateRange('week', now).startTime).toBe(
      new Date(2024, 1, 26).getTime() / 1000
    )
    expect(resolveReportDateRange('month', now)).toEqual({
      startTime: new Date(2024, 1, 1).getTime() / 1000,
      endTime: now.getTime() / 1000
    })
    expect(resolveReportDateRange('week', new Date(2026, 9, 25, 12)).startTime).toBe(
      new Date(2026, 9, 19).getTime() / 1000
    )
  })
  it('accepts an explicit window and rejects incomplete or reversed dates', () => {
    expect(
      resolveReportDateRange('custom', new Date(), {
        start: '2026-10-01T09:00',
        end: '2026-10-03T18:00'
      })
    ).toEqual({
      startTime: new Date(2026, 9, 1, 9).getTime() / 1000,
      endTime: new Date(2026, 9, 3, 18).getTime() / 1000
    })
    expect(() => resolveReportDateRange('custom')).toThrow('有效')
    expect(() =>
      resolveReportDateRange('custom', new Date(), {
        start: '2026-02-30T09:00',
        end: '2026-03-03T18:00'
      })
    ).toThrow('有效')
    expect(() =>
      resolveReportDateRange('custom', new Date(), { start: '2026-10-03', end: '2026-10-01' })
    ).toThrow('早于')
  })
  it('clamps image counts and removes unsupported modules without changing disabled selections', () => {
    expect(normalizeReportPreferences({ imageLimit: 99, sections: [] })).toMatchObject({
      imageLimit: 20,
      sections: [],
      imageMethod: 'vision'
    })
    expect(
      normalizeReportPreferences({ imageLimit: 0, density: 'detailed', imageMethod: 'ocr-only' })
    ).toMatchObject({ imageLimit: 0, density: 'detailed', imageMethod: 'ocr-only' })
  })
  it('enforces selected sections in the report data, including external templates', () => {
    const preferences = normalizeReportPreferences({ density: 'concise', sections: ['resources'] })
    const metadata: GroupReportMetadata = {
      groupName: 'fixture-group',
      reportDate: '2026-10-01',
      dateRange: 'fixture',
      messageCount: 20,
      activeUsers: 2,
      timeSpan: '1 h',
      generatedAt: '',
      recordNote: '',
      footerNote: '',
      heroParticipants: [],
      avatars: {},
      reportMode: 'compact',
      reportPreferences: preferences
    }
    const report = parseGroupDailyReport(
      JSON.stringify({
        topics: [],
        todos: [{ task: 'fixture-task', confidence: 1 }],
        resources: [{ title: 'fixture-resource', description: 'fixture-link' }]
      }),
      [],
      '',
      [],
      metadata,
      { gallery: [], voiceHighlights: [], funBadges: [] }
    )
    expect(report.topics).toEqual([])
    expect(report.todos).toEqual([])
    expect(report.resources).toHaveLength(1)
    expect(report.sectionMeta?.topics?.enabled).toBe(false)
    expect(report.sectionMeta?.resources?.enabled).toBe(true)
    expect(report.summaryStats?.todoCount).toBe(0)
  })
})
