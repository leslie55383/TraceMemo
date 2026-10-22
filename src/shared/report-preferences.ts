import type { ReportSectionKey } from './group-report'
import { normalizeReportImageLimit, type ReportImageSelectionMode } from './image-insight'

export type ReportDensity = 'concise' | 'standard' | 'detailed'
export type ReportImageMethod = 'vision' | 'ocr-only' | 'ocr-first'
export interface ReportModelRef {
  providerId: string
  model: string
}
export interface ReportPreferences {
  imageLimit: number
  imageSelectionMode: ReportImageSelectionMode
  imageMethod: ReportImageMethod
  density: ReportDensity
  sections: ReportSectionKey[]
  textModel?: ReportModelRef
  visionModel?: ReportModelRef
}
export const REPORT_SECTION_OPTIONS: Array<{ value: ReportSectionKey; label: string }> = [
  { value: 'topics', label: '今日话题' },
  { value: 'importantMessages', label: '重要消息' },
  { value: 'actions', label: '待办与未解决问题' },
  { value: 'qa', label: '问题与解答' },
  { value: 'resources', label: '实用资源' },
  { value: 'moments', label: '精彩对话' },
  { value: 'analytics', label: '活跃统计' },
  { value: 'keywords', label: '关键词' },
  { value: 'vision', label: '图片精选' },
  { value: 'voices', label: '语音精选' },
  { value: 'storylines', label: '话题进展' },
  { value: 'reversals', label: '观点变化' },
  { value: 'chains', label: '参与链路' },
  { value: 'badges', label: '趣味徽章' }
]
export const normalizeReportPreferences = (
  raw: Partial<ReportPreferences> = {}
): ReportPreferences => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {}
  const model = (ref?: ReportModelRef): ReportModelRef | undefined =>
    ref &&
    typeof ref.providerId === 'string' &&
    ref.providerId.trim() &&
    typeof ref.model === 'string' &&
    ref.model.trim()
      ? { providerId: ref.providerId.trim(), model: ref.model.trim() }
      : undefined
  return {
    imageLimit: normalizeReportImageLimit(raw.imageLimit),
    imageSelectionMode: raw.imageSelectionMode === 'hot-first' ? 'hot-first' : 'hot-only',
    imageMethod:
      raw.imageMethod === 'ocr-only' || raw.imageMethod === 'ocr-first'
        ? raw.imageMethod
        : 'vision',
    density: raw.density === 'concise' || raw.density === 'detailed' ? raw.density : 'standard',
    sections: Array.isArray(raw.sections)
      ? REPORT_SECTION_OPTIONS.map((o) => o.value).filter((key) => raw.sections!.includes(key))
      : REPORT_SECTION_OPTIONS.map((o) => o.value),
    textModel: model(raw.textModel),
    visionModel: model(raw.visionModel)
  }
}

/** API 的显式参数必须有效，不能把拼错的 OCR 模式静默回落为云端识图。 */
export function validateReportPreferencePatch(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['日报配置必须是对象']
  const raw = value as Record<string, unknown>
  const errors: string[] = []
  const allowed = [
    'imageLimit',
    'imageSelectionMode',
    'imageMethod',
    'density',
    'sections',
    'textModel',
    'visionModel'
  ]
  if (Object.keys(raw).some((key) => !allowed.includes(key)))
    errors.push('日报配置包含不支持的字段')
  if (
    raw.imageLimit !== undefined &&
    (!Number.isInteger(raw.imageLimit) || Number(raw.imageLimit) < 0 || Number(raw.imageLimit) > 20)
  )
    errors.push('图片识别数量必须为 0–20 的整数')
  for (const [key, options] of Object.entries({
    imageSelectionMode: ['hot-only', 'hot-first'],
    imageMethod: ['vision', 'ocr-only', 'ocr-first'],
    density: ['concise', 'standard', 'detailed']
  })) {
    if (raw[key] !== undefined && !options.includes(String(raw[key])))
      errors.push(`${key} 配置无效`)
  }
  if (
    raw.sections !== undefined &&
    (!Array.isArray(raw.sections) ||
      raw.sections.some((key) => !REPORT_SECTION_OPTIONS.some((option) => option.value === key)))
  )
    errors.push('日报模块配置无效')
  for (const key of ['textModel', 'visionModel']) {
    if (raw[key] === undefined) continue
    const ref = raw[key] as Record<string, unknown> | null
    if (
      !ref ||
      typeof ref !== 'object' ||
      Array.isArray(ref) ||
      Object.keys(ref).some((field) => !['providerId', 'model'].includes(field)) ||
      !['providerId', 'model'].every(
        (field) =>
          typeof ref[field] === 'string' &&
          String(ref[field]).trim().length > 0 &&
          String(ref[field]).length <= 300
      )
    )
      errors.push(`${key} 配置无效`)
  }
  return errors
}
