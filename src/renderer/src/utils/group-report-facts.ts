import { Contact, Message } from '../../../shared/types'
import {
  GroupDailyReport,
  GroupReportMetadata,
  ReportFunBadge,
  ReportMode,
  ReportSpeakerRank,
  ReportVisionGalleryItem,
  ReportVoiceHighlight,
  ReportVoiceLeaderboardItem
} from '../../../shared/group-report'
import type {
  ImageAnalysisRequest,
  ImageAnalysisResponse,
  ImageCandidate,
  ImageCandidateQuery,
  ImageCandidateResponse,
  ImageInsight,
  ReportImageSelectionStats,
  ReportImageSelectionMode
} from '../../../shared/image-insight'
import {
  calculateImageHeatScore,
  isHotImageCandidate,
  normalizeReportImageLimit
} from '../../../shared/image-insight'
import type { ReportModelChoice } from '../../../shared/ai-provider'
import type { ReportImageMethod, ReportPreferences } from '../../../shared/report-preferences'
import type { SystemOcrRequest, SystemOcrResult } from '../../../shared/system-ocr'

interface ReportImageReadResult {
  success: boolean
  data?: string
  error?: string
}

export interface ReportMediaApi {
  imageListCandidates: (query: ImageCandidateQuery) => Promise<ImageCandidateResponse>
  imageAnalyze: (request: ImageAnalysisRequest) => Promise<ImageAnalysisResponse>
  getImage: (
    imageMd5?: string,
    imageDatNameOrThumb?: string | boolean,
    sessionId?: string,
    options?: { includeData?: boolean }
  ) => Promise<ReportImageReadResult>
  recognizeLocalImageText?: (request: SystemOcrRequest) => Promise<SystemOcrResult>
}

declare const window: { api: ReportMediaApi }

export interface GroupReportTranscriptRow {
  id: string
  datetime: string
  timestamp: number
  sender: string
  content: string
  avatar?: string
}

export interface GroupReportFactsSnapshot {
  metadata: GroupReportMetadata
  transcriptRows: GroupReportTranscriptRow[]
  topSpeakers: ReportSpeakerRank[]
  activeTimeline: string
  media: GroupDailyReport['media']
  voiceLeaderboard: ReportVoiceLeaderboardItem[]
  factsPrompt: string
  imageInsightSummary: ReportImageInsightSummary
}

export interface ReportImageInsightItem {
  messageId: string
  sender: string
  time: string
  description: string
  ocrText?: string
  tags: string[]
  source?: 'local-ocr' | 'vision'
  category?: ImageInsight['category']
  importance?: ImageInsight['importance']
}

export interface ReportImageInsightFailure {
  messageId?: string
  sender: string
  time?: string
  error: string
}

export interface ReportImageInsightSummary {
  total: number
  selection?: ReportImageSelectionStats
  succeeded: number
  failed: number
  items: ReportImageInsightItem[]
  failures: ReportImageInsightFailure[]
}

export interface ReportPreparationProgress {
  stage: 'selectingImages' | 'recognizingImages' | 'summarizingInput'
  label: string
  completed?: number
  total?: number
}

export interface BuildGroupReportFactsOptions {
  onProgress?: (progress: ReportPreparationProgress) => void
  visionModel?: Pick<ReportModelChoice, 'providerId' | 'model'> & Partial<ReportModelChoice>
  imageLimit?: number
  imageSelectionMode?: ReportImageSelectionMode
  imageMethod?: ReportImageMethod
  preferences?: ReportPreferences
  imageApi?: ReportMediaApi
  selectedImageIds?: string[]
  previousInsights?: ReportImageInsightItem[]
}

function friendlyImageNotice(warnings: string[]): string {
  const detail = warnings.join(' ')
  if (/模型.*不支持|vision|multimodal|image.*support/i.test(detail)) {
    return '当前 AI 模型暂未通过图片理解验证，已跳过图片精选；文字日报不受影响。'
  }
  if (/解密|密钥|未找到|读取失败/.test(detail)) {
    return '部分图片在本机暂不可用，已跳过图片精选；文字日报不受影响。'
  }
  if (/格式.*不支持|图片格式/.test(detail)) {
    return '部分图片暂不适合 AI 分析，已跳过图片精选；文字日报不受影响。'
  }
  return '图片精选暂未生成，文字消息、统计和关键词仍已正常处理。'
}

export const isInternalIdentifier = (value: string): boolean =>
  /@chatroom$/i.test(value) || /^wxid_/i.test(value) || /^[a-z0-9_-]{18,}$/i.test(value)

const isSystemMessage = (message: Message): boolean =>
  message.from === 'system' || message.type === '系统消息' || message.contentData?.type === 'system'

export const summarySender = (
  message: Message,
  contact: Contact | null,
  isGroup: boolean
): string => {
  if (isSystemMessage(message)) return '微信系统消息'
  if (message.from === 'assistant') {
    const ownGroupNickname = message.name?.trim()
    if (isGroup && ownGroupNickname && !isInternalIdentifier(ownGroupNickname)) {
      return ownGroupNickname
    }
    return '我'
  }
  const candidate = isGroup ? message.name : contact?.m_nsNickName
  if (!candidate || isInternalIdentifier(candidate)) return isGroup ? '未命名群成员' : '对方'
  return candidate
}

export const summaryContent = (message: Message): string => {
  const data = message.contentData
  if (message.type === '语音' || data?.type === 'voice') {
    // 语音时长来自 <voicemsg voicelength>（毫秒），是带小数的秒（1600ms → 1.6）：
    // 累加时保留精度，只在显示给人的文案里取整。
    const durationSec = data?.type === 'voice' ? data.duration : undefined
    const durationLabel = durationSec ? ` ${Math.round(durationSec)}秒` : ''
    return message.voiceTranscript?.trim()
      ? `[语音${durationLabel}] ${message.voiceTranscript.trim()}`
      : `[语音${durationLabel}]`
  }
  if (!data) return message.content?.trim() || `[${message.type || '消息'}]`

  switch (data.type) {
    case 'image':
      return '[图片]'
    case 'sticker':
      return '[表情]'
    case 'share':
      return data.articles?.length
        ? `[分享] ${data.articles
            .map(
              (article) =>
                `${article.title}${article.description ? `：${article.description}` : ''}`
            )
            .join('；')}`
        : `[分享] ${data.title}${data.des ? `：${data.des}` : ''}`
    case 'quote': {
      const reply = data.title || data.content || message.content || '[回复]'
      const quotedSender =
        data.quotedSender && !isInternalIdentifier(data.quotedSender) ? data.quotedSender : '群成员'
      return `${reply}（引用 ${quotedSender}：${data.quotedContent || `[引用${data.quotedType || '消息'}]`}）`
    }
    case 'location':
      return `[位置] ${data.poiname || data.label || '位置消息'}`
    case 'card':
      return `[名片] ${data.nickname || '微信名片'}`
    case 'voip':
      return `[通话] ${data.status}${data.duration ? `，${data.duration}秒` : ''}`
    case 'system':
    case 'text':
      return data.content
    case 'unknown':
      return `[${message.type || '未知消息'}]`
  }

  return `[${message.type || '消息'}]`
}

export const parseTimestamp = (message: Message): number => {
  const value = new Date(message.datetime).getTime()
  return Number.isFinite(value) ? value : 0
}

export const localDate = (timestamp: number): string => {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export const localTime = (timestamp: number): string =>
  new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  })

export const resolveVoiceDuration = (message: Message): number => {
  const fromData = message.contentData?.type === 'voice' ? message.contentData.duration : undefined
  return Math.max(0, Number(fromData ?? message.voiceDuration ?? 0) || 0)
}

const truncate = (value: string, max = 48): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value

const buildImageContext = (
  messages: Message[],
  index: number,
  contact: Contact | null,
  isGroup: boolean
): {
  note: string
  stats: string
  responseCount: number
  participantCount: number
  interactionCount: number
  snippets: string[]
} => {
  const baseTime = parseTimestamp(messages[index])
  const participants = new Set<string>()
  const snippets: string[] = []
  let responseCount = 0
  let interactionCount = 0

  for (let offset = index + 1; offset < messages.length && offset <= index + 8; offset++) {
    const candidate = messages[offset]
    const candidateTime = parseTimestamp(candidate)
    if (baseTime && candidateTime && candidateTime - baseTime > 20 * 60 * 1000) break
    if (candidate.type === '系统消息' || candidate.from === 'system') continue

    const sender = summarySender(candidate, contact, isGroup)
    const sameSender = sender === summarySender(messages[index], contact, isGroup)
    const content = summaryContent(candidate)
    if (!sameSender) {
      responseCount += 1
      participants.add(sender)
    }
    if (candidate.contentData?.type === 'sticker' || candidate.contentData?.type === 'voice') {
      interactionCount += 1
    }
    if (
      snippets.length < 3 &&
      !content.startsWith('[图片]') &&
      !content.startsWith('[表情]') &&
      !content.startsWith('[语音')
    ) {
      snippets.push(truncate(content, 28))
    }
  }

  const note = snippets.length
    ? `图片发出后，群里接着聊到：${snippets.join(' / ')}`
    : responseCount > 0
      ? '图片发出后引发了一波接续讨论。'
      : '这张图片更多像是一次轻量分享，没有形成长链路讨论。'

  const statsParts: string[] = []
  if (responseCount > 0) statsParts.push(`${responseCount} 条后续消息`)
  if (participants.size > 0) statsParts.push(`${participants.size} 人接话`)
  if (!statsParts.length) statsParts.push('讨论热度较低')

  return {
    note,
    stats: statsParts.join(' · '),
    responseCount,
    participantCount: participants.size,
    interactionCount,
    snippets
  }
}

export function getReportImageInputs(
  messages: Message[],
  contact: Contact | null,
  isGroup: boolean
): NonNullable<ImageCandidateQuery['inputs']> {
  return messages.flatMap((message, index) => {
    if (message.contentData?.type !== 'image') return []
    const context = buildImageContext(messages, index, contact, isGroup)
    return [
      {
        messageId: message.id,
        md5: message.contentData.md5,
        datName: message.contentData.datName,
        sessionId: message.sessionId || contact?.m_nsUsrName || '',
        sender: summarySender(message, contact, isGroup),
        sentAt: parseTimestamp(message),
        responseCount: context.responseCount,
        interactionCount: context.interactionCount
      }
    ]
  })
}

const buildMediaSection = async (
  messages: Message[],
  contact: Contact | null,
  isGroup: boolean,
  topSpeakersMap: Map<string, number>,
  options: BuildGroupReportFactsOptions = {}
): Promise<{
  media: GroupDailyReport['media']
  voiceLeaderboard: ReportVoiceLeaderboardItem[]
  warnings: string[]
  imageInsightSummary: ReportImageInsightSummary
}> => {
  const warnings: string[] = []
  const imageFailures: ReportImageInsightFailure[] = []
  let imageCandidateTotal = 0
  let imageSelection: ReportImageSelectionStats | undefined
  const imageLimit = normalizeReportImageLimit(options.imageLimit)
  const imageSelectionMode = options.imageSelectionMode ?? 'hot-only'
  const rendererApi = options.imageApi ?? (typeof window === 'undefined' ? null : window.api)
  const rawImageCandidates = getReportImageInputs(messages, contact, isGroup)
    .map((input) => ({
      ...input,
      sourceMessageIds: [input.messageId],
      time: localTime(input.sentAt),
      score: calculateImageHeatScore(input),
      isHot: isHotImageCandidate(input)
    }))
    .sort((left, right) => Number(right.isHot) - Number(left.isHot) || right.score - left.score)
  const eligibleImageCandidates = rawImageCandidates.filter(
    (item) =>
      imageLimit > 0 &&
      (!options.selectedImageIds || options.selectedImageIds.includes(item.messageId)) &&
      (options.selectedImageIds || imageSelectionMode === 'hot-first' || item.isHot)
  )

  // ============================================================
  // AI 图片理解(ImageInsightService 接入)
  // 通过 main 进程按配置选择图片 + 已缓存的 Insight;
  // 未缓存的并发调 AI。失败不阻塞文字日报。
  // ============================================================
  let visionGallery: ReportVisionGalleryItem[] = []
  try {
    if (!rendererApi) throw new Error('后台模式不读取 Renderer 图片')
    options.onProgress?.({ stage: 'selectingImages', label: '筛选日报图片' })
    const sessionId = messages.find((m) => m.sessionId)?.sessionId || (contact?.md5 ?? '')
    const startTime = messages.length ? parseTimestamp(messages[0]) : 0
    const endTime = messages.length ? parseTimestamp(messages[messages.length - 1]) : 0

    // 从 renderer 已加载的消息中提取图片候选(复用 buildImageContext 已算的 replyCount)
    const imageInputs = rawImageCandidates
      .filter(
        (c) => !options.selectedImageIds || options.selectedImageIds.includes(c.sourceMessageIds[0])
      )
      .map((c) => {
        return {
          messageId: c.sourceMessageIds[0] || '',
          md5: c.md5,
          datName: c.datName,
          sessionId: c.sessionId || sessionId,
          sender: c.sender,
          sentAt: c.sentAt,
          responseCount: c.responseCount || 0,
          interactionCount: c.interactionCount || 0
        }
      })

    const candidatesResp: ImageCandidateResponse =
      imageLimit > 0
        ? await rendererApi.imageListCandidates({
            sessionId,
            startTime,
            endTime,
            limit: imageLimit,
            selectionMode: options.selectedImageIds ? 'hot-first' : imageSelectionMode,
            inputs: imageInputs
          })
        : {
            success: true,
            candidates: [],
            selection: {
              inputCount: rawImageCandidates.length,
              excludedByHotRule: 0,
              unavailable: 0,
              duplicates: 0,
              excludedByLimit: 0,
              disabled: true
            }
          }
    const candidates = candidatesResp.success ? candidatesResp.candidates : []
    imageSelection = candidatesResp.selection
    if (imageSelection && options.selectedImageIds)
      imageSelection = {
        ...imageSelection,
        inputCount: rawImageCandidates.length,
        excludedByUser: rawImageCandidates.length - imageInputs.length
      }
    imageCandidateTotal = candidates.length
    console.log('[buildMediaSection] imageListCandidates returned', candidates.length, 'candidates')

    if (!candidatesResp.success && eligibleImageCandidates.length) {
      imageCandidateTotal = Math.min(imageLimit, eligibleImageCandidates.length)
      for (const candidate of eligibleImageCandidates.slice(0, imageCandidateTotal)) {
        imageFailures.push({
          messageId: candidate.sourceMessageIds[0],
          sender: candidate.sender,
          time: candidate.time,
          error: ('error' in candidatesResp && candidatesResp.error) || '日报图片筛选失败'
        })
      }
    }

    options.onProgress?.({
      stage: 'recognizingImages',
      label: candidates.length
        ? '识别图片中'
        : imageLimit === 0
          ? '已关闭图片识别'
          : '未找到可识别的图片',
      completed: 0,
      total: candidates.length
    })

    // 对每个候选:缓存命中直接用,未命中并发调 imageAnalyze
    let analyzedCount = 0
    const analyzeCandidate = async (candidate: ImageCandidate): Promise<ImageInsight | null> => {
      const finish = (): void => {
        analyzedCount += 1
        options.onProgress?.({
          stage: 'recognizingImages',
          label: '识别图片中',
          completed: analyzedCount,
          total: candidates.length
        })
      }
      const previous = options.previousInsights?.find(
        (item) => item.messageId === candidate.messageId
      )
      if (previous) {
        finish()
        return {
          ...previous,
          id: candidate.messageId,
          imageHash: candidate.imageHash,
          sentAt: candidate.sentAt,
          sessionId: candidate.sessionId,
          category: previous.category || 'other',
          importance: previous.importance || 'medium',
          provider: previous.source === 'local-ocr' ? 'local-ocr' : 'previous-result',
          model: '',
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      }
      if (candidate.insight) {
        if (
          (!options.imageMethod || options.imageMethod === 'vision') &&
          (!options.visionModel ||
            (candidate.insight.provider === options.visionModel.providerId &&
              candidate.insight.model === options.visionModel.model))
        ) {
          finish()
          return candidate.insight
        }
      }
      // 未命中:解密图片拿 base64 → 调 AI
      try {
        const img = await rendererApi.getImage(
          candidate.md5,
          candidate.datName,
          candidate.sessionId,
          { includeData: true }
        )
        if (!img.success || !img.data) {
          warnings.push(
            `${candidate.sender} ${localTime(candidate.sentAt)} 的图片读取失败：${img.error || '未知错误'}`
          )
          imageFailures.push({
            messageId: candidate.messageId,
            sender: candidate.sender,
            time: localTime(candidate.sentAt),
            error: img.error || '图片读取失败'
          })
          return null
        }
        if (options.imageMethod === 'ocr-only' || options.imageMethod === 'ocr-first') {
          let ocr: SystemOcrResult | undefined
          try {
            ocr = await rendererApi.recognizeLocalImageText?.({
              imageDataUrl: img.data,
              imageHash: candidate.imageHash
            })
          } catch (error) {
            if (options.imageMethod === 'ocr-only') throw error
          }
          if (ocr?.success && ocr.text.trim()) {
            return {
              id: `local-ocr:${candidate.messageId}`,
              messageId: candidate.messageId,
              imageHash: candidate.imageHash,
              description: '本地 OCR 提取的图片文字（未进行图意分析）',
              ocrText: ocr.text,
              tags: ['本地文字识别'],
              category: 'document',
              importance: 'medium',
              provider: 'local-ocr',
              model: ocr.engine,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              sender: candidate.sender,
              sentAt: candidate.sentAt,
              sessionId: candidate.sessionId
            }
          }
          if (options.imageMethod === 'ocr-only')
            throw new Error(ocr?.error || '本地 OCR 未识别到文字；未调用视觉模型')
        }
        const analyzeResp = await rendererApi.imageAnalyze({
          imageHash: candidate.imageHash,
          imageDataUrl: img.data,
          messageId: candidate.messageId,
          sender: candidate.sender,
          sentAt: candidate.sentAt,
          sessionId: candidate.sessionId,
          providerId: options.visionModel?.providerId,
          modelId: options.visionModel?.model,
          force: false
        })
        if (!analyzeResp.success || !analyzeResp.insight) {
          warnings.push(
            `${candidate.sender} ${localTime(candidate.sentAt)} 的图片识别失败：${analyzeResp.error || '模型未返回识别结果'}`
          )
          imageFailures.push({
            messageId: candidate.messageId,
            sender: candidate.sender,
            time: localTime(candidate.sentAt),
            error: analyzeResp.error || '模型未返回识别结果'
          })
          return null
        }
        return analyzeResp.insight
      } catch (error) {
        console.warn('[buildMediaSection] image analyze failed:', error)
        warnings.push(
          `${candidate.sender} ${localTime(candidate.sentAt)} 的图片识别异常：${error instanceof Error ? error.message : String(error)}`
        )
        imageFailures.push({
          messageId: candidate.messageId,
          sender: candidate.sender,
          time: localTime(candidate.sentAt),
          error: error instanceof Error ? error.message : String(error)
        })
        return null
      } finally {
        finish()
      }
    }
    // 数量增加时仍最多并行 3 个识别请求，避免同时占满视觉模型连接。
    const analyzed: Array<ImageInsight | null> = Array(candidates.length).fill(null)
    let nextCandidate = 0
    await Promise.all(
      Array.from({ length: Math.min(3, candidates.length) }, async () => {
        while (nextCandidate < candidates.length) {
          const index = nextCandidate++
          analyzed[index] = await analyzeCandidate(candidates[index])
        }
      })
    )
    // 缓存只复用图片内容，来源始终使用本次选中的消息，避免跨群转发串错成员和时间。
    visionGallery = analyzed.flatMap((it, index) =>
      it
        ? [
            {
              messageId: candidates[index].messageId,
              imageHash: it.imageHash,
              sender: candidates[index].sender,
              time: localTime(candidates[index].sentAt),
              description: it.description,
              ocrText: it.ocrText,
              tags: it.tags,
              category: it.category,
              importance: it.importance,
              source: it.provider === 'local-ocr' ? ('local-ocr' as const) : ('vision' as const),
              sourceMessageIds: [candidates[index].messageId]
            }
          ]
        : []
    )
    // 为 visionGallery 加载原图 dataUrl(给 main 渲染用,不暴露给 LLM)
    if (visionGallery.length) {
      visionGallery = await Promise.all(
        visionGallery.map(async (item) => {
          const orig = rawImageCandidates.find((c) => c.sourceMessageIds[0] === item.messageId)
          if (!orig) return item
          try {
            const img = await rendererApi.getImage(orig.md5, orig.datName, orig.sessionId, {
              includeData: true
            })
            if (img.success && img.data?.startsWith('data:image/')) {
              return { ...item, imageUrl: img.data }
            }
          } catch (error) {
            console.warn('[buildMediaSection] preload image failed for', item.messageId, error)
          }
          return item
        })
      )
    }
  } catch (error) {
    console.warn('[buildMediaSection] vision flow failed, fallback to empty:', error)
    warnings.push(`图片识别流程失败：${error instanceof Error ? error.message : String(error)}`)
    if (!imageFailures.length && eligibleImageCandidates.length) {
      imageCandidateTotal = Math.min(imageLimit, eligibleImageCandidates.length)
      for (const candidate of eligibleImageCandidates.slice(0, imageCandidateTotal)) {
        imageFailures.push({
          messageId: candidate.sourceMessageIds[0],
          sender: candidate.sender,
          time: candidate.time,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    visionGallery = []
  }

  options.onProgress?.({
    stage: 'summarizingInput',
    label: '汇总图片识别结果',
    completed: visionGallery.length,
    total: imageCandidateTotal
  })

  const voiceMessages = messages
    .filter((message) => message.contentData?.type === 'voice')
    .map((message) => ({
      sender: summarySender(message, contact, isGroup),
      duration: resolveVoiceDuration(message),
      time: localTime(parseTimestamp(message))
    }))

  const voiceTotals = new Map<string, { count: number; duration: number }>()
  for (const item of voiceMessages) {
    const current = voiceTotals.get(item.sender) || { count: 0, duration: 0 }
    current.count += 1
    current.duration += item.duration
    voiceTotals.set(item.sender, current)
  }

  const voiceLeaderboard: ReportVoiceLeaderboardItem[] = Array.from(voiceTotals.entries())
    .map(([sender, value]) => ({
      sender,
      count: value.count,
      durationSec: value.duration
    }))
    .sort((left, right) => right.durationSec - left.durationSec || right.count - left.count)
    .slice(0, 5)

  let bestStreak: { sender: string; count: number; duration: number; time: string } | null = null
  let currentStreak: { sender: string; count: number; duration: number; time: string } | null = null
  for (const message of messages) {
    if (message.contentData?.type !== 'voice') {
      currentStreak = null
      continue
    }
    const sender = summarySender(message, contact, isGroup)
    const duration = resolveVoiceDuration(message)
    const time = localTime(parseTimestamp(message))
    if (currentStreak && currentStreak.sender === sender) {
      currentStreak.count += 1
      currentStreak.duration += duration
    } else {
      currentStreak = { sender, count: 1, duration, time }
    }
    if (!bestStreak || currentStreak.count > bestStreak.count) {
      bestStreak = { ...currentStreak }
    }
  }

  const voiceHighlights: ReportVoiceHighlight[] = []
  if (voiceLeaderboard[0]) {
    voiceHighlights.push({
      title: '语音输出王',
      sender: voiceLeaderboard[0].sender,
      note: `共发送 ${voiceLeaderboard[0].count} 条语音，累计 ${Math.round(voiceLeaderboard[0].durationSec)} 秒。`
    })
  }
  if (bestStreak && bestStreak.count >= 2) {
    voiceHighlights.push({
      title: '连续发言时刻',
      sender: bestStreak.sender,
      note: `${bestStreak.time} 连发 ${bestStreak.count} 条语音，共 ${Math.round(bestStreak.duration)} 秒。`
    })
  }

  const funBadges: ReportFunBadge[] = []
  const topSpeaker = Array.from(topSpeakersMap.entries()).sort(
    (left, right) => right[1] - left[1]
  )[0]
  if (topSpeaker) {
    funBadges.push({
      title: '高能输出王',
      owner: topSpeaker[0],
      note: `今日一共发了 ${topSpeaker[1]} 条消息。`
    })
  }
  if (visionGallery[0]) {
    funBadges.push({
      title: '图片话题王',
      owner: visionGallery[0].sender,
      note: `${visionGallery[0].time} 的热点图片进入了 AI 图片精选。`
    })
  }
  if (voiceLeaderboard[0]) {
    funBadges.push({
      title: '语音麦霸',
      owner: voiceLeaderboard[0].sender,
      note: `语音总时长暂居第一，适合放进“今日声音档案”。`
    })
  }

  return {
    media: {
      // 保留旧字段以兼容历史报告，但新日报不再生成或读取“群聊相册”。
      gallery: [],
      visionGallery,
      voiceHighlights: voiceHighlights.slice(0, 2),
      funBadges: funBadges.slice(0, 3)
    },
    voiceLeaderboard,
    warnings,
    imageInsightSummary: {
      total: imageCandidateTotal,
      selection: imageSelection,
      succeeded: visionGallery.length,
      failed: imageFailures.length,
      items: visionGallery.map((item) => ({
        messageId: item.messageId,
        sender: item.sender,
        time: item.time,
        description: item.description,
        ocrText: item.ocrText,
        tags: item.tags,
        source: item.source,
        category: item.category,
        importance: item.importance
      })),
      failures: imageFailures
    }
  }
}

const collectQuestionCandidates = (
  messages: Message[],
  contact: Contact | null,
  isGroup: boolean
): string[] =>
  messages
    .map((message) => ({
      id: message.id,
      sender: summarySender(message, contact, isGroup),
      content: summaryContent(message)
    }))
    .filter(
      (item) =>
        /[?？]$/.test(item.content) || item.content.includes('吗') || item.content.includes('怎么')
    )
    .slice(-6)
    .map((item) => `${item.sender}（${item.id}）：${truncate(item.content, 32)}`)

const collectReplyFacts = (
  messages: Message[],
  contact: Contact | null,
  isGroup: boolean
): string[] =>
  messages
    .filter((message) => message.contentData?.type === 'quote' && message.contentData.quotedSender)
    .slice(0, 10)
    .map((message) => {
      const sender = summarySender(message, contact, isGroup)
      const quotedSender =
        message.contentData?.type === 'quote' && message.contentData.quotedSender
          ? message.contentData.quotedSender
          : '群成员'
      return `${sender} 回复了 ${quotedSender}`
    })

export const buildGroupReportFacts = async (
  messages: Message[],
  contact: Contact | null,
  isGroup: boolean,
  reportMode: ReportMode,
  options: BuildGroupReportFactsOptions = {}
): Promise<GroupReportFactsSnapshot> => {
  const transcriptRows = messages.map((message) => ({
    id: message.id,
    datetime: message.datetime,
    timestamp: parseTimestamp(message),
    sender: summarySender(message, contact, isGroup),
    content: summaryContent(message),
    avatar: message.img
  }))

  let firstTimestamp = Number.POSITIVE_INFINITY
  let lastTimestamp = Number.NEGATIVE_INFINITY
  for (const row of transcriptRows) {
    if (!Number.isFinite(row.timestamp)) continue
    firstTimestamp = Math.min(firstTimestamp, row.timestamp)
    lastTimestamp = Math.max(lastTimestamp, row.timestamp)
  }
  if (!Number.isFinite(firstTimestamp)) firstTimestamp = Date.now()
  if (!Number.isFinite(lastTimestamp)) lastTimestamp = firstTimestamp

  const speakerCounts = new Map<string, number>()
  const hourCounts = new Map<number, number>()
  const avatars: Record<string, string | undefined> = {}
  let imageCount = 0
  let stickerCount = 0
  let voiceCount = 0
  let voiceDurationSec = 0

  for (const message of messages) {
    const sender = summarySender(message, contact, isGroup)
    const timestamp = parseTimestamp(message)
    if (!isSystemMessage(message)) {
      speakerCounts.set(sender, (speakerCounts.get(sender) || 0) + 1)
      if (message.img && !avatars[sender]) avatars[sender] = message.img
    }
    if (Number.isFinite(timestamp)) {
      const hour = new Date(timestamp).getHours()
      hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1)
    }
    if (message.contentData?.type === 'image') imageCount += 1
    if (message.contentData?.type === 'sticker') stickerCount += 1
    if (message.contentData?.type === 'voice') {
      voiceCount += 1
      voiceDurationSec += resolveVoiceDuration(message)
    }
  }

  const topSpeakers = Array.from(speakerCounts, ([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 5)

  const activeTimeline = Array.from(hourCounts, ([hour, count]) => ({ hour, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 4)
    .sort((left, right) => left.hour - right.hour)
    .map(
      ({ hour, count }) =>
        `${String(hour).padStart(2, '0')}:00-${String(hour).padStart(2, '0')}:59（${count}条）`
    )
    .join('、')

  const startDate = localDate(firstTimestamp)
  const endDate = localDate(lastTimestamp)
  const sameDay = startDate === endDate
  const dateRange = sameDay
    ? `${startDate} ${localTime(firstTimestamp)}-${localTime(lastTimestamp)}`
    : `${startDate} ${localTime(firstTimestamp)} 至 ${endDate} ${localTime(lastTimestamp)}`
  const durationMs = Math.max(0, lastTimestamp - firstTimestamp)
  const durationHours = durationMs / 3600000
  const timeSpan = (() => {
    if (sameDay) {
      if (durationHours < 1) {
        const minutes = Math.max(1, Math.round(durationMs / 60000))
        return `${minutes} min`
      }
      const hours = Math.max(1, Math.ceil(durationHours))
      return `${hours} h`
    }
    const days = Math.max(1, Math.ceil(durationMs / 86400000))
    return `${days} d`
  })()

  const contactName = contact?.m_nsNickName || ''
  const groupName = contactName && !isInternalIdentifier(contactName) ? contactName : '未命名会话'
  const metadata: GroupReportMetadata = {
    groupName,
    reportDate: sameDay ? startDate : `${startDate}_to_${endDate}`,
    dateRange,
    messageCount: transcriptRows.length,
    activeUsers: speakerCounts.size,
    imageCount,
    voiceCount,
    stickerCount,
    mediaMessageCount: imageCount + voiceCount + stickerCount,
    timeSpan,
    generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    recordNote: `基于 TraceMemo 已加载的 ${transcriptRows.length} 条记录`,
    footerNote: '基于已读取聊天记录生成；图片、表情等未解析内容默认只按类型与上下文参与日报。',
    heroParticipants: topSpeakers.slice(0, 4).map((speaker) => speaker.name),
    avatars,
    reportMode,
    /**
     * 会话标识：导出层 `enrichAvatarsFromGroup` 靠它反查群成员快照补头像。
     *
     * 必须用 `m_nsUsrName`（群 roomid，形如 `xxx@chatroom`）而不是群名 —— 群名是展示名，
     * 可能重名或带表情符号；`resolveMd5` 对 roomid / md5 / wxid 都是精确匹配。
     * 此前这个字段从未被赋值，导致那条 enrich 分支实际是死代码，头像只能靠消息自带的 img。
     */
    ...(contact?.m_nsUsrName ? { talker: contact.m_nsUsrName } : {})
  }

  const { media, voiceLeaderboard, warnings, imageInsightSummary } = await buildMediaSection(
    messages,
    contact,
    isGroup,
    speakerCounts,
    options
  )
  if (warnings.length) metadata.warnings = [...(metadata.warnings || []), ...warnings]
  if (imageCount > 0 && !media.visionGallery?.length) {
    metadata.footerNote = friendlyImageNotice(warnings)
  } else if (media.visionGallery?.length) {
    const localCount = media.visionGallery.filter((item) => item.source === 'local-ocr').length
    metadata.footerNote = `基于已读取聊天记录生成；本地 OCR ${localCount} 张，视觉模型识别 ${media.visionGallery.length - localCount} 张。`
  }

  if (
    transcriptRows.length > 0 &&
    transcriptRows.every((row) => row.content === '[图片]') &&
    imageInsightSummary.total > 0 &&
    imageInsightSummary.failed === 0 &&
    !media.visionGallery?.length
  ) {
    throw new Error(
      '当前范围只有图片，但这些图片暂时无法分析。请改选文字消息，或在设置中验证图片理解能力。'
    )
  }

  const factsPrompt = [
    `报告模式：${reportMode === 'compact' ? '精简版（30秒可读完）' : '完整版（保留更多上下文）'}`,
    `消息统计：共 ${transcriptRows.length} 条，活跃成员 ${speakerCounts.size} 人，图片 ${imageCount} 张，表情 ${stickerCount} 条，语音 ${voiceCount} 条（累计 ${Math.round(voiceDurationSec)} 秒）。`,
    activeTimeline ? `活跃时段：${activeTimeline}` : '',
    // AI 图片理解结果(由 ImageInsightService 提供,缓存命中或已调用 Vision)
    (media.visionGallery?.length ?? 0) > 0
      ? `AI 图片识别摘要：${(media.visionGallery || [])
          .map(
            (it) =>
              `[${it.time} ${it.sender}] ${it.description}${it.ocrText ? `（OCR: ${it.ocrText}）` : ''}${it.tags.length ? ` [${it.tags.join('/')}]` : ''}`
          )
          .join('；')}`
      : '',
    voiceLeaderboard.length
      ? `语音榜：${voiceLeaderboard
          .slice(0, 3)
          .map((item) => `${item.sender} ${item.count} 条 / ${Math.round(item.durationSec)} 秒`)
          .join('；')}`
      : '',
    collectQuestionCandidates(messages, contact, isGroup).length
      ? `疑似待跟进问题：${collectQuestionCandidates(messages, contact, isGroup).join('；')}`
      : '',
    collectReplyFacts(messages, contact, isGroup).length
      ? `回复关系样本：${collectReplyFacts(messages, contact, isGroup).join('；')}`
      : ''
  ]
    .filter(Boolean)
    .join('\n')

  return {
    metadata,
    transcriptRows,
    topSpeakers,
    activeTimeline,
    media,
    voiceLeaderboard,
    factsPrompt,
    imageInsightSummary
  }
}
