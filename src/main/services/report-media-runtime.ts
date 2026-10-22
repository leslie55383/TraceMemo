import type { ReportMediaApi } from '../../renderer/src/utils/group-report-facts'
import { transcribeVoiceMessages } from '../../renderer/src/utils/voice-message-reference'

let runtime: ReportMediaApi | undefined
export const bindReportMediaRuntime = (api: ReportMediaApi): void => {
  runtime = api
}
export const getReportMediaRuntime = (): ReportMediaApi | undefined => runtime
let voiceRuntime: Parameters<typeof transcribeVoiceMessages>[1] | undefined
export const bindReportVoiceRuntime = (
  value: Parameters<typeof transcribeVoiceMessages>[1]
): void => {
  voiceRuntime = value
}
export const prepareReportVoiceMessages = async (
  messages: Parameters<typeof transcribeVoiceMessages>[0]
): Promise<Parameters<typeof transcribeVoiceMessages>[0]> => {
  if (!messages.some((m) => m.type === '语音' || m.contentData?.type === 'voice')) return messages
  if (!voiceRuntime) throw new Error('日报语音转写尚未就绪')
  return transcribeVoiceMessages(messages, voiceRuntime)
}
