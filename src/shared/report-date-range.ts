export type ReportDateRange = 'today' | 'yesterday' | '7days' | 'week' | 'month' | 'custom'
export interface CustomReportRange {
  start: string
  end: string
}
export const reportRangeLabel = (range: string): string =>
  ({
    today: '今日',
    yesterday: '昨日',
    '7days': '近 7 天',
    week: '本周',
    month: '本月',
    custom: '自定义',
    recent24h: '最近 24 小时'
  })[range] || range
export function resolveReportDateRange(
  range: ReportDateRange,
  now = new Date(),
  custom?: CustomReportRange
): { startTime: number; endTime: number } {
  if (range === 'custom') {
    const boundary = (value: string | undefined, end: boolean): number => {
      if (typeof value !== 'string') return NaN
      const match =
        /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(
          value
        )
      if (!match) return NaN
      const [year, month, day] = match.slice(1, 4).map(Number)
      const check = new Date(Date.UTC(year, month - 1, day))
      if (
        check.getUTCFullYear() !== year ||
        check.getUTCMonth() !== month - 1 ||
        check.getUTCDate() !== day ||
        Number(match[4] || 0) > 23 ||
        Number(match[5] || 0) > 59 ||
        Number(match[6] || 0) > 59
      )
        return NaN
      const date = match[4]
        ? new Date(value)
        : new Date(year, month - 1, day, end ? 23 : 0, end ? 59 : 0, end ? 59 : 0)
      return Math.floor(date.getTime() / 1000)
    }
    const startTime = boundary(custom?.start, false)
    const endTime = boundary(custom?.end, true)
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime))
      throw new Error('请填写有效的开始和结束时间')
    if (endTime < startTime) throw new Error('结束时间不能早于开始时间')
    return { startTime, endTime }
  }
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  let endTime = Math.floor(now.getTime() / 1000)
  if (range === 'yesterday') {
    endTime = Math.floor(start.getTime() / 1000) - 1
    start.setDate(start.getDate() - 1)
  }
  if (range === '7days') start.setDate(start.getDate() - 6)
  if (range === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  if (range === 'month') start.setDate(1)
  return { startTime: Math.floor(start.getTime() / 1000), endTime }
}
