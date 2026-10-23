import { randomUUID } from 'crypto'
import type { Contact, Message } from '../../shared/types'
import type { GroupDailyReport, GroupReportMetadata } from '../../shared/group-report'
import { exportGroupReport } from '../group-report-service'
import { getGroupSnapshot, listMessages, resolveMd5 } from './chat-service'
import { AIProviderService } from './ai-provider-service'
import type {
  ScheduledReportMemberNameMode,
  ScheduledReportMessageType
} from '../../shared/scheduled-report'
import type { ScheduledReportExecutionStage } from '../../shared/scheduled-report'
import type { SelectableReportTemplateId } from '../../shared/report-templates'
import { resolveMemberName } from '../../shared/member-names'
import {
  normalizeReportPreferences,
  validateReportPreferencePatch,
  type ReportPreferences
} from '../../shared/report-preferences'
import type { CustomReportRange } from '../../shared/report-date-range'
import { loadReportPreferences } from './report-preferences-service'
import { getReportMediaRuntime, prepareReportVoiceMessages } from './report-media-runtime'
import {
  prepareLongReportInput,
  reportResponseUsage,
  ReportSummaryError
} from '../../shared/report-long-record'
import {
  buildGroupReportInput,
  getSummaryDateRange,
  GROUP_REPORT_JSON_REPAIR_SYSTEM_PROMPT,
  GROUP_REPORT_SYSTEM_PROMPT,
  isInternalName,
  parseGroupDailyReport,
  type SummaryDateRange
} from '../../renderer/src/utils/group-report'

const aiProvider = new AIProviderService()

/**
 * 用真实群成员快照补全消息的显示名与头像。
 *
 * **头像与名称的门槛刻意不同**：
 *
 * 此前这里先用 `isInternalName(message.name)` 做整体早退 —— 只有当消息里的名字还是内部标识
 * （空 / `wxid_*` / `*@chatroom` / 18+ 位字母数字）时才继续。但 `listMessages` 产出的 `name`
 * 优先取 `senderNickname`，在真实群里通常是**已可读的昵称**，于是整条记录被跳过、
 * `member.avatar` 永远补不上，导出层只能退化成首字头像；软件内日报没有这个门槛，
 * 所以它能显示真实头像。
 *
 * 现在：**只要 senderId 命中真实群成员就允许补头像**；名称只在解析结果确实是可读名时才采用，
 * 避免把调用方已有的昵称降级成空串或内部标识。消息自带的 `img` 始终优先。
 */
export function hydrateGroupMemberIdentity(
  messages: Message[],
  members: ReadonlyArray<NonNullable<ReturnType<typeof getGroupSnapshot>>['members'][number]>,
  memberNameMode: ScheduledReportMemberNameMode
): Message[] {
  const index = new Map(
    members.map((member) => [
      member.wxid,
      { name: resolveMemberName(member, memberNameMode), avatar: member.avatar }
    ])
  )
  return messages.map((message) => {
    const member = index.get(String(message.senderId || message.name || ''))
    if (!member) return message
    const shouldFillAvatar = !message.img && Boolean(member.avatar)
    const resolvedName = member.name && !isInternalName(member.name) ? member.name : message.name
    if (!shouldFillAvatar && resolvedName === message.name) return message
    return {
      ...message,
      name: resolvedName,
      ...(shouldFillAvatar ? { img: member.avatar } : {})
    }
  })
}

export interface AgentGroupReportRequest {
  preferences?: Partial<ReportPreferences>
  customRange?: CustomReportRange
  group: string
  range?: SummaryDateRange | 'recent24h'
  messageTypes?: ScheduledReportMessageType[]
  templateId?: SelectableReportTemplateId
  memberNameMode?: ScheduledReportMemberNameMode
  timeoutSeconds?: number
}

export interface AgentGroupReportResult {
  success: boolean
  groupName?: string
  htmlPath?: string
  pngPath?: string
  messageCount?: number
  reportSnapshot?: GroupDailyReport
  reportMetadata?: GroupReportMetadata
  modelName?: string
  tokenUsage?: {
    input?: number
    output?: number
    total?: number
    estimated?: boolean
  }
  duration?: number
  error?: string
  errorCode?: string
  errorStage?: ScheduledReportExecutionStage
  errorStatus?: number
  errorType?: string
}

export async function generateAgentGroupReport(
  request: AgentGroupReportRequest
): Promise<AgentGroupReportResult> {
  const startedAt = Date.now()
  if (request.preferences !== undefined) {
    const issues = validateReportPreferencePatch(request.preferences)
    if (issues.length)
      return reportFailure(issues.join('；'), 'precheck', 'REPORT_GENERATION_FAILED')
  }
  if (
    request.range &&
    !['today', 'yesterday', '7days', 'week', 'month', 'custom', 'recent24h'].includes(request.range)
  )
    return reportFailure('不支持的日报时间范围', 'data', 'REPORT_GENERATION_FAILED')
  const query = String(request.group || '')
    .trim()
    .replace(/群聊?$/, '')
    .trim()
  if (!query) return reportFailure('缺少群聊名称', 'data', 'CHAT_NOT_FOUND')
  const contact = resolveMd5(query)
  if (!contact) return reportFailure(`没有找到群聊“${query}”`, 'data', 'CHAT_NOT_FOUND')
  if (contact.type !== 'group' && !contact.m_nsUsrName.endsWith('@chatroom')) {
    return reportFailure(`“${query}”不是群聊`, 'data', 'CHAT_NOT_FOUND')
  }

  const preferences = normalizeReportPreferences({
    ...loadReportPreferences(),
    ...request.preferences
  })
  const range = request.range && request.range !== 'recent24h' ? request.range : 'today'
  let times: { startTime: number; endTime: number }
  try {
    times =
      request.range === 'recent24h'
        ? (() => {
            const now = Math.floor(Date.now() / 1000)
            return { startTime: now - 86400, endTime: now }
          })()
        : getSummaryDateRange(range, request.customRange)
  } catch (error) {
    return reportFailure(
      error instanceof Error ? error.message : String(error),
      'data',
      'REPORT_GENERATION_FAILED'
    )
  }
  const { startTime, endTime } = times
  let messages = listMessages(contact.md5, startTime, endTime) as Message[]
  if (!messages.length) return reportFailure('所选时间范围没有可总结的消息', 'data', 'NO_MESSAGES')

  const messageTypeMap: Record<ScheduledReportMessageType, string[]> = {
    text: ['普通文本'],
    image: ['图片'],
    sticker: ['表情包'],
    video: ['视频'],
    voice: ['语音'],
    share: ['分享消息', '名片', '位置', '通话'],
    file: ['文件'],
    system: ['系统消息']
  }
  const selectedTypes = new Set(
    (request.messageTypes?.length
      ? request.messageTypes
      : (Object.keys(messageTypeMap) as ScheduledReportMessageType[])
    ).flatMap((type) => messageTypeMap[type] || [])
  )
  messages = messages.filter((message) => selectedTypes.has(message.type))
  if (!messages.length) return reportFailure('所选时间范围没有可总结的消息', 'data', 'NO_MESSAGES')

  const snapshot = getGroupSnapshot(contact.md5)
  if (snapshot) {
    messages = hydrateGroupMemberIdentity(
      messages,
      snapshot.members,
      request.memberNameMode || 'groupNickname'
    )
  }

  let input: Awaited<ReturnType<typeof buildGroupReportInput>>
  try {
    messages = await prepareReportVoiceMessages(messages)
    input = await buildGroupReportInput(
      messages,
      contact as Contact,
      true,
      preferences.density === 'concise' ? 'compact' : 'full',
      {
        imageApi: getReportMediaRuntime(),
        imageLimit: preferences.imageLimit,
        imageSelectionMode: preferences.imageSelectionMode,
        imageMethod: preferences.imageMethod,
        preferences,
        visionModel: preferences.visionModel
      }
    )
  } catch (error) {
    return reportFailure(
      error instanceof Error ? error.message : String(error),
      'data',
      'REPORT_GENERATION_FAILED'
    )
  }
  if (input.imageInsightSummary.failed > 0)
    return reportFailure(
      `有 ${input.imageInsightSummary.failed} 张图片处理失败，已停止本次后台日报。请在手动日报中重试或排除失败图片。`,
      'data',
      'REPORT_GENERATION_FAILED'
    )
  if (
    messages.every((message) => message.contentData?.type === 'image') &&
    input.imageInsightSummary.succeeded === 0
  )
    return reportFailure(
      '当前范围只有未识别的图片，请检查选图规则和识别配置',
      'data',
      'REPORT_GENERATION_FAILED'
    )
  const runtime = aiProvider.getRuntimeConfig()
  const sessionId = randomUUID()
  const deadlineAt = Date.now() + Math.max(30, Math.min(1800, request.timeoutSeconds || 300)) * 1000
  let prepared: Awaited<ReturnType<typeof prepareLongReportInput>>
  try {
    prepared = await prepareLongReportInput({
      prompt: input.prompt,
      source: input.summarySource,
      systemPrompt: GROUP_REPORT_SYSTEM_PROMPT,
      deadlineAt,
      summarize: (messages, timeoutMs) =>
        aiProvider.chat(messages, {
          sessionId,
          providerId: preferences.textModel?.providerId,
          modelId: preferences.textModel?.model,
          timeoutMs
        })
    })
  } catch (error) {
    const response = error instanceof ReportSummaryError ? error.response : undefined
    return {
      ...reportFailure(
        error instanceof Error ? error.message : String(error),
        'ai',
        response?.errorCode || 'REPORT_GENERATION_FAILED'
      ),
      ...(response?.errorStatus !== undefined ? { errorStatus: response.errorStatus } : {}),
      ...(response?.errorType ? { errorType: response.errorType } : {})
    }
  }
  if (prepared.stats) {
    input.metadata.longRecordSummary = prepared.stats
    input.metadata.recordNote += `；长记录分 ${prepared.stats.chunks} 段整理后汇总，压缩可能省略细节`
  }
  if (Date.now() >= deadlineAt)
    return reportFailure(
      '长记录处理超时，请增加日报超时或缩小范围',
      'ai',
      'REPORT_GENERATION_FAILED'
    )
  const ai = await aiProvider.chat(
    [
      { role: 'system', content: GROUP_REPORT_SYSTEM_PROMPT },
      { role: 'user', content: prepared.prompt }
    ],
    {
      sessionId,
      providerId: preferences.textModel?.providerId,
      modelId: preferences.textModel?.model,
      timeoutMs: Math.max(1, deadlineAt - Date.now())
    }
  )
  if (!ai.success || !ai.data) {
    return {
      ...reportFailure(ai.error || 'AI 总结失败', 'ai', ai.errorCode),
      ...(ai.errorStatus !== undefined ? { errorStatus: ai.errorStatus } : {}),
      ...(ai.errorType ? { errorType: ai.errorType } : {})
    }
  }
  let tokenUsage = mergeTokenUsage(
    prepared.usage,
    reportResponseUsage(GROUP_REPORT_SYSTEM_PROMPT, prepared.prompt, ai)
  )
  if (ai.finishReason && !['stop', 'end_turn'].includes(ai.finishReason)) {
    return reportFailure(
      `模型未完整生成日报（${ai.finishReason}），请检查模型输出上限`,
      'ai',
      'REPORT_GENERATION_FAILED'
    )
  }
  const parseReport = (raw: string): ReturnType<typeof parseGroupDailyReport> =>
    parseGroupDailyReport(
      raw,
      input.topSpeakers,
      input.activeTimeline,
      input.voiceLeaderboard,
      input.metadata,
      input.media
    )
  let report: ReturnType<typeof parseGroupDailyReport>
  try {
    report = parseReport(ai.data)
  } catch (parseError) {
    if (Date.now() >= deadlineAt)
      return reportFailure(
        '日报处理超时，未执行 JSON 修复，请增加超时或缩小范围',
        'ai',
        'REPORT_GENERATION_FAILED'
      )
    const repaired = await aiProvider.chat(
      [
        { role: 'system', content: GROUP_REPORT_JSON_REPAIR_SYSTEM_PROMPT },
        { role: 'user', content: ai.data }
      ],
      {
        sessionId,
        providerId: preferences.textModel?.providerId,
        modelId: preferences.textModel?.model,
        timeoutMs: Math.max(1, deadlineAt - Date.now())
      }
    )
    if (!repaired.success || !repaired.data) {
      const cause = parseError instanceof Error ? parseError.message : String(parseError)
      return {
        ...reportFailure(
          `${repaired.error || 'AI 修复日报 JSON 失败'}（原始错误：${cause}）`,
          'ai',
          repaired.errorCode
        ),
        ...(repaired.errorStatus !== undefined ? { errorStatus: repaired.errorStatus } : {}),
        ...(repaired.errorType ? { errorType: repaired.errorType } : {})
      }
    }
    tokenUsage = mergeTokenUsage(
      tokenUsage,
      reportResponseUsage(GROUP_REPORT_JSON_REPAIR_SYSTEM_PROMPT, ai.data, repaired)
    )
    if (repaired.finishReason && !['stop', 'end_turn'].includes(repaired.finishReason)) {
      return reportFailure(
        `模型未完整修复日报（${repaired.finishReason}），请检查模型输出上限`,
        'ai',
        'REPORT_GENERATION_FAILED'
      )
    }
    try {
      report = parseReport(repaired.data)
    } catch (repairError) {
      return reportFailure(
        repairError instanceof Error ? repairError.message : String(repairError),
        'report',
        'REPORT_GENERATION_FAILED'
      )
    }
  }
  const exported = await exportGroupReport({
    report,
    metadata: input.metadata,
    templateId: request.templateId
  })
  if (!exported.success || !exported.pngPath) {
    return reportFailure(exported.error || '总结图片生成失败', 'report', 'REPORT_GENERATION_FAILED')
  }
  return {
    success: true,
    groupName: input.metadata.groupName,
    htmlPath: exported.htmlPath,
    pngPath: exported.pngPath,
    messageCount: messages.length,
    reportSnapshot: report,
    reportMetadata: input.metadata,
    modelName: preferences.textModel?.model || runtime.modelName || runtime.model,
    tokenUsage,
    duration: Date.now() - startedAt
  }
}

function mergeTokenUsage(
  first: AgentGroupReportResult['tokenUsage'],
  second: AgentGroupReportResult['tokenUsage']
): AgentGroupReportResult['tokenUsage'] {
  if (!first) return second
  if (!second) return first
  return {
    input: (first.input || 0) + (second.input || 0),
    output: (first.output || 0) + (second.output || 0),
    total: (first.total || 0) + (second.total || 0),
    estimated: Boolean(first.estimated || second.estimated)
  }
}

function reportFailure(
  error: string,
  errorStage: ScheduledReportExecutionStage,
  errorCode?: string
): AgentGroupReportResult {
  return {
    success: false,
    error,
    errorStage,
    ...(errorCode ? { errorCode } : {})
  }
}
