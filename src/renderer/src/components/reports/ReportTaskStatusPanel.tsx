import React, { useEffect, useState } from 'react'
import type { AIProviderSummary } from '../../../../shared/ai-provider'
import {
  AiModelConfig,
  REPORT_TASK_STEPS,
  ReportGenerationPhase,
  VoiceTranscriptionProgress
} from '../../hooks/useGroupReportGeneration'
import type {
  ReportImageInsightSummary,
  ReportPreparationProgress
} from '../../utils/group-report-facts'
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui'

interface ReportTaskStatusPanelProps {
  phase: ReportGenerationPhase
  error: string
  voiceTranscriptionProgress: VoiceTranscriptionProgress | null
  voiceTranscriptionEnabled: boolean
  preparationProgress: ReportPreparationProgress | null
  imageInsightSummary: ReportImageInsightSummary
  canRetryModelStep: boolean
  currentModel: AiModelConfig
  onRetry: (model?: AiModelConfig) => void
  onContinueAfterImageFailures: () => void
  onCancelAfterImageFailures: () => void
  onRetryFailedImages?: () => void
}

interface ModelChoice {
  key: string
  label: string
  config: AiModelConfig
}

const providerCanRun = (provider: AIProviderSummary): boolean =>
  Boolean(
    provider.models.some((model) => model.capabilities.chat) &&
    (provider.hasApiKey || provider.type === 'ollama' || provider.auth.type === 'none')
  )

const modelChoices = (providers: AIProviderSummary[]): ModelChoice[] =>
  providers.flatMap((provider) =>
    providerCanRun(provider)
      ? provider.models
          .filter((model) => model.capabilities.chat)
          .map((model) => ({
            key: `${provider.id}::${model.id}`,
            label: `${provider.name} · ${model.name || model.id}`,
            config: {
              providerId: provider.id,
              providerName: provider.name,
              model: model.id,
              modelName: model.name || model.id,
              configured: true,
              status: provider.status,
              timeoutMs: provider.advanced.timeoutMs
            }
          }))
      : []
  )

export function ReportTaskStatusPanel({
  phase,
  error,
  voiceTranscriptionProgress,
  voiceTranscriptionEnabled,
  preparationProgress,
  imageInsightSummary,
  canRetryModelStep,
  currentModel,
  onRetry,
  onContinueAfterImageFailures,
  onCancelAfterImageFailures,
  onRetryFailedImages
}: ReportTaskStatusPanelProps): React.ReactElement {
  const taskSteps = voiceTranscriptionEnabled
    ? REPORT_TASK_STEPS
    : REPORT_TASK_STEPS.filter((step) => step.id !== 'transcribingVoice')
  const activeIndex = taskSteps.findIndex((step) => step.id === phase)
  const effectiveActiveIndex =
    phase === 'awaitingImageDecision'
      ? taskSteps.findIndex((step) => step.id === 'preparingInput')
      : activeIndex
  const completedAll = phase === 'success'
  const [logPath, setLogPath] = useState('')
  const [choices, setChoices] = useState<ModelChoice[]>([])
  const [selectedModelKey, setSelectedModelKey] = useState('')
  const [modelLoadError, setModelLoadError] = useState('')

  useEffect(() => {
    void window.api
      .getAppLogPath()
      .then(setLogPath)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!canRetryModelStep) return
    let active = true
    void window.api
      .listAIProviders()
      .then((result) => {
        if (!active) return
        if (!result.success) {
          setModelLoadError(result.error || '模型列表读取失败')
          return
        }
        const nextChoices = modelChoices(result.providers)
        setChoices(nextChoices)
        const currentKey = `${currentModel.providerId || ''}::${currentModel.model}`
        setSelectedModelKey(
          nextChoices.some((choice) => choice.key === currentKey)
            ? currentKey
            : nextChoices[0]?.key || ''
        )
      })
      .catch((loadError) => {
        if (active) {
          setModelLoadError(loadError instanceof Error ? loadError.message : '模型列表读取失败')
        }
      })
    return () => {
      active = false
    }
  }, [canRetryModelStep, currentModel.model, currentModel.providerId])

  const selectedModel = choices.find((choice) => choice.key === selectedModelKey)?.config
  const imageDecisionPending = phase === 'awaitingImageDecision'

  return (
    <aside className="report-task-panel">
      <div className="report-task-header">
        <h2>任务状态</h2>
        <p>
          {completedAll
            ? '生成完成'
            : imageDecisionPending
              ? '等待确认'
              : phase === 'error'
                ? '生成失败'
                : effectiveActiveIndex >= 0
                  ? `${effectiveActiveIndex + 1}/${taskSteps.length}`
                  : '等待开始'}
        </p>
      </div>
      <div className="report-task-steps">
        {taskSteps.map((step, index) => {
          const state =
            completedAll || (effectiveActiveIndex >= 0 && index < effectiveActiveIndex)
              ? 'done'
              : effectiveActiveIndex === index
                ? 'active'
                : 'waiting'
          return (
            <div key={step.id} className={`report-task-step ${state}`}>
              <span className="report-task-dot" aria-hidden />
              <div>
                <b>{step.label}</b>
                <small>
                  {state === 'done' ? '已完成' : state === 'active' ? '进行中' : '等待中'}
                </small>
              </div>
            </div>
          )
        })}
      </div>
      {(phase === 'preparingInput' || phase === 'requestingModel' || imageDecisionPending) &&
        preparationProgress && (
          <div className="report-preparation-progress">
            <div>
              <strong>{preparationProgress.label}</strong>
              {preparationProgress.total ? (
                <span>
                  {preparationProgress.completed || 0}/{preparationProgress.total}
                </span>
              ) : null}
            </div>
            {preparationProgress.total ? (
              <progress
                value={preparationProgress.completed || 0}
                max={preparationProgress.total}
                aria-label="图片识别进度"
              />
            ) : null}
          </div>
        )}
      {imageInsightSummary.selection && imageInsightSummary.selection.inputCount > 0 && (
        <div className="report-preparation-progress" aria-label="日报图片筛选说明">
          <p>
            图片消息 {imageInsightSummary.selection.inputCount} 条 · 本次选中{' '}
            {imageInsightSummary.total} 张
          </p>
          {imageInsightSummary.selection.disabled ? (
            <p>已关闭图片识别；图片仅按消息类型和聊天上下文参与总结。</p>
          ) : (
            <>
              {(imageInsightSummary.selection.excludedByUser || 0) > 0 && (
                <p>手动排除 {imageInsightSummary.selection.excludedByUser} 条图片消息。</p>
              )}
              {imageInsightSummary.selection.excludedByHotRule > 0 && (
                <p>
                  未达热点条件 {imageInsightSummary.selection.excludedByHotRule}{' '}
                  条；可开启普通图片补入。
                </p>
              )}
              {imageInsightSummary.selection.duplicates > 0 && (
                <p>重复图片合并 {imageInsightSummary.selection.duplicates} 条。</p>
              )}
              {imageInsightSummary.selection.unavailable > 0 && (
                <p>缺少可用图片标识或本地资源 {imageInsightSummary.selection.unavailable} 条。</p>
              )}
              {imageInsightSummary.selection.excludedByLimit > 0 && (
                <p>
                  受识别数量上限限制，另有 {imageInsightSummary.selection.excludedByLimit}{' '}
                  张未入选。
                </p>
              )}
            </>
          )}
        </div>
      )}
      {imageInsightSummary.total > 0 && (
        <details className="report-image-insights" open={imageDecisionPending}>
          <summary>
            图片识别：成功 {imageInsightSummary.succeeded} 张
            {imageInsightSummary.failed > 0 ? ` · 失败 ${imageInsightSummary.failed} 张` : ''}
          </summary>
          <div className="report-image-insight-list">
            {imageInsightSummary.items.map((item) => (
              <article key={`${item.messageId}:${item.time}`}>
                <div>
                  <b>{item.sender}</b>
                  <time>{item.time}</time>
                </div>
                <p>{item.description}</p>
                {item.source && (
                  <small>
                    {item.source === 'local-ocr' ? '来源：本地 OCR，仅提取文字' : '来源：视觉模型'}
                  </small>
                )}
                {item.ocrText ? <small>OCR：{item.ocrText}</small> : null}
                {item.tags.length ? <small>标签：{item.tags.join(' / ')}</small> : null}
              </article>
            ))}
            {imageInsightSummary.failures.map((failure, index) => (
              <article
                key={`${failure.messageId || failure.sender}:${failure.time || index}`}
                className="failed"
              >
                <div>
                  <b>{failure.sender}</b>
                  {failure.time ? <time>{failure.time}</time> : null}
                </div>
                <p>识别失败：{failure.error}</p>
              </article>
            ))}
          </div>
        </details>
      )}
      {imageDecisionPending && (
        <div className="report-image-decision">
          <b>有 {imageInsightSummary.failed} 张图片识别失败</b>
          <p>
            已成功识别的 {imageInsightSummary.succeeded}{' '}
            张图片仍会参与总结。失败图片只按消息类型和聊天上下文处理，不会猜测具体内容。
          </p>
          <div>
            {onRetryFailedImages && (
              <Button variant="outline" onClick={onRetryFailedImages}>
                仅重试失败图片
              </Button>
            )}
            <Button onClick={onContinueAfterImageFailures}>继续文字总结</Button>
            <Button variant="outline" onClick={onCancelAfterImageFailures}>
              停止生成
            </Button>
          </div>
        </div>
      )}
      {phase === 'transcribingVoice' && voiceTranscriptionProgress && (
        <div className="report-voice-progress">
          <div>
            <span>语音转写</span>
            <strong>
              {voiceTranscriptionProgress.processed}/{voiceTranscriptionProgress.total}
            </strong>
          </div>
          <progress
            value={voiceTranscriptionProgress.processed}
            max={Math.max(1, voiceTranscriptionProgress.total)}
            aria-label="语音转写进度"
          />
          <small>
            成功 {voiceTranscriptionProgress.succeeded} 条，失败 {voiceTranscriptionProgress.failed}{' '}
            条
          </small>
        </div>
      )}
      {phase === 'error' && (
        <div className="report-task-error">
          <b>错误摘要</b>
          <p>{error}</p>
          {canRetryModelStep ? (
            <div className="report-model-retry">
              <label htmlFor="report-retry-model">切换模型</label>
              <Select
                key={choices.length ? 'ready' : 'loading'}
                value={selectedModelKey || undefined}
                disabled={!choices.length}
                onValueChange={setSelectedModelKey}
              >
                <SelectTrigger id="report-retry-model" aria-label="切换模型">
                  <SelectValue placeholder="正在读取模型列表" />
                </SelectTrigger>
                <SelectContent>
                  {choices.map((choice) => (
                    <SelectItem key={choice.key} value={choice.key}>
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <small>
                复用聊天记录和图片结果，从模型步骤继续；同一模型复用成功分段，切换模型则重新整理分段。
              </small>
              {modelLoadError ? <small className="error">{modelLoadError}</small> : null}
              <Button disabled={!selectedModel} onClick={() => onRetry(selectedModel)}>
                使用所选模型重新生成
              </Button>
            </div>
          ) : (
            <Button onClick={() => onRetry()}>从头重试</Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => void window.api.revealAppLog()}>
            打开诊断日志
          </Button>
          {logPath && <small className="report-task-log-path">{logPath}</small>}
        </div>
      )}
      {phase === 'success' && (
        <div className="report-task-success">
          <b>生成成功</b>
          <p>HTML 与 PNG 已导出，可以查看生成结果。</p>
        </div>
      )}
      <div className="report-task-note">
        模型调用耗时取决于你配置的服务，当前只展示真实执行阶段。
      </div>
    </aside>
  )
}
