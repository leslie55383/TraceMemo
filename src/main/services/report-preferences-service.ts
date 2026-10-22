import { app } from 'electron'
import { join } from 'path'
import fs from 'fs-extra'
import {
  normalizeReportPreferences,
  validateReportPreferencePatch,
  type ReportPreferences
} from '../../shared/report-preferences'

export function loadReportPreferences(): ReportPreferences {
  try {
    return normalizeReportPreferences(
      fs.readJsonSync(join(app.getPath('userData'), 'report-preferences.json'))
    )
  } catch {
    return normalizeReportPreferences()
  }
}
export function saveReportPreferences(value: Partial<ReportPreferences>): ReportPreferences {
  const issues = validateReportPreferencePatch(value)
  if (issues.length) throw new Error(issues.join('；'))
  const preferences = normalizeReportPreferences(value)
  const path = join(app.getPath('userData'), 'report-preferences.json')
  fs.outputJsonSync(path + '.tmp', preferences, { spaces: 2 })
  fs.moveSync(path + '.tmp', path, { overwrite: true })
  return preferences
}
