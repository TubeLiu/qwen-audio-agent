import { randomBytes, randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { config } from '../../core/config.mjs'
import { PERMISSION_DECISIONS } from '../../../../shared/permission-decisions.mjs'
import { resolveRealtimeFrontendConfiguration } from '../../../../shared/realtime-provider-catalog.mjs'
import {
  buildFrontendInstructions, frontendTools, resultResponseInstructions,
  speakResponseInstructions, permissionResponseInstructions,
} from '../../frontend/frontend-tools.mjs'
import { createMiMoRealtimeBridge } from './mimo-bridge.mjs'

let bridge = null
let bridgeConnection = null
let starting = null

export function miMoPipelineConfiguration(runtime = config) {
  return {
    apiBaseUrl: runtime.mimoBaseUrl?.replace(/\/+$/, ''), apiKey: runtime.mimoApiKey, chatModel: runtime.mimoChatModel,
    sttProvider: 'mimo', sttBaseUrl: runtime.mimoAsrBaseUrl?.replace(/\/+$/, ''), sttApiKey: runtime.mimoAsrApiKey, sttModel: runtime.mimoAsrModel,
    ttsProvider: 'mimo', ttsBaseUrl: runtime.mimoTtsBaseUrl?.replace(/\/+$/, ''), ttsApiKey: runtime.mimoTtsApiKey, ttsModel: runtime.mimoTtsModel, ttsVoice: runtime.mimoTtsVoice,
  }
}

export function isMiMoRealtimeConfigured(runtimeConfig = config) {
  const pipeline = miMoPipelineConfiguration(runtimeConfig)
  return Boolean(pipeline.apiBaseUrl && pipeline.apiKey && pipeline.chatModel
    && pipeline.sttBaseUrl && pipeline.sttApiKey && pipeline.sttModel
    && pipeline.ttsBaseUrl && pipeline.ttsApiKey && pipeline.ttsModel)
}

export async function startMiMoRealtimeBridge({ runtimeConfig = config, fetcher = fetch } = {}) {
  if (runtimeConfig.audioProvider !== 'mimo' && !isMiMoRealtimeConfigured(runtimeConfig)) return null
  if (starting) return starting
  if (bridgeConnection) return bridgeConnection
  starting = (async () => {
    const token = randomBytes(32).toString('hex')
    const candidate = createMiMoRealtimeBridge({ config: miMoPipelineConfiguration(runtimeConfig), WebSocketServer, bridgeToken: token, fetcher })
    try {
      const address = await candidate.listen()
      bridge = candidate
      bridgeConnection = { url: `ws://127.0.0.1:${address.port}/realtime`, token }
      return bridgeConnection
    } catch (error) { await candidate.close(); throw error }
  })()
  try { return await starting } finally { starting = null }
}

export async function closeMiMoRealtimeBridge() {
  if (starting) await starting.catch(() => {})
  const active = bridge; bridge = null; bridgeConnection = null
  if (active) await active.close()
}

export function createMiMoProtocol() {
  const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`
  return {
    encodeOutgoing: payload => ({ event_id: id('event'), ...payload }),
    normalizeIncoming: event => event.type === 'mimo.speech_unavailable'
      ? { type: 'response.audio.failed', response_id: event.response_id, message: event.message }
      : event,
    sessionUpdate: session => ({ type: 'session.update', session }),
    audioAppend: audio => ({ type: 'input_audio_buffer.append', audio }),
    imageAppend: () => { throw new Error('MiMo 语音管线仅支持文字与音频输入。') }, clearImageBuffer: () => undefined,
    conversationItemId: () => id('item'),
    conversationItemCreate: (item, { contextOnly = true } = {}) => ({ type: 'conversation.item.create', item, context_only: contextOnly }),
    responseCreate: response => ({ type: 'response.create', ...(response ? { response } : {}) }),
    correlateResponseCreate: (payload, correlationId) => ({ ...payload, response: { ...payload.response, metadata: { ...payload.response?.metadata, correlation_id: correlationId } } }),
    responseCorrelationId: event => event.response?.metadata?.correlation_id || '', responseCancel: () => ({ type: 'response.cancel' }),
    userTextItem: text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }),
    functionOutputItem: (callId, output) => ({ type: 'function_call_output', call_id: callId, output: JSON.stringify(output) }),
    inputMute: () => ({ type: 'input.mute' }), inputUnmute: () => ({ type: 'input.unmute' }), sessionClose: () => ({ type: 'session.close' }),
  }
}

export function createMiMoRealtimeProvider({ runtimeConfig = config, connection = () => bridgeConnection } = {}) {
  const pipeline = miMoPipelineConfiguration(runtimeConfig)
  const modalities = () => pipeline.ttsApiKey && pipeline.ttsModel ? ['text', 'audio'] : ['text']
  const profile = () => ({
    id: pipeline.chatModel || 'mimo-unconfigured', label: 'MiMo ASR / Chat / TTS', family: 'mimo-pipeline',
    modelCapabilities: { textInput: true, audioInput: true, imageInput: false, videoInput: false, textOutput: true, audioOutput: Boolean(pipeline.ttsApiKey && pipeline.ttsModel), functionCalling: true },
    transportCapabilities: { textInput: true, audioInput: true, imageInput: false, imageBufferInput: false },
    sessionDefaults: { voice: pipeline.ttsVoice || 'mimo_default', turnDetection: { type: 'server_vad', silence_duration_ms: 750, threshold: 0.018 } },
  })
  return {
    key: 'mimo', label: 'MiMo ASR / Chat / TTS', inputSampleRate: 16000, outputSampleRate: 24000,
    createProtocol: createMiMoProtocol,
    capabilities: { perResponseInstructions: true, singleResponseSlot: true, responseMetadataCorrelation: true, sessionOutputVoice: true, automaticToolResponses: false, mutableSession: true, acknowledgesSessionUpdate: true, acknowledgesConversationItems: true, conversationItemIdEcho: true, restoreConversationContext: true, conversationItems: true, clientResponses: true, imageRequiresAudioStart: false },
    model: () => pipeline.chatModel || 'mimo-unconfigured', modelProfile: profile, voice: () => profile().sessionDefaults.voice,
    isConfigured: () => isMiMoRealtimeConfigured(runtimeConfig),
    url: () => {
      const target = connection()
      if (!target) throw new Error('本机 MiMo 适配器尚未启动。')
      const url = new URL(target.url)
      if (!['ws:', 'wss:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || url.username || url.password || url.pathname !== '/realtime' || url.search || url.hash || !target.token || target.token.length < 32) throw new Error('MiMo 适配器需要私有本机连接和独立令牌。')
      return url.toString()
    },
    headers: () => ({ Authorization: `Bearer ${connection()?.token || ''}` }),
    missingConfigurationMessage: '请配置 MiMo 文字、识别及合成服务的独立 API Key。', connectTimeoutMessage: '本机 MiMo 语音适配器连接超时。',
    configurationSignature: () => resolveRealtimeFrontendConfiguration({
      QWEN_AUDIO_REALTIME_PROVIDER: 'mimo', MIMO_CHAT_BASE_URL: runtimeConfig.mimoBaseUrl, MIMO_CHAT_API_KEY: pipeline.apiKey, MIMO_CHAT_MODEL: pipeline.chatModel,
      MIMO_ASR_BASE_URL: runtimeConfig.mimoAsrBaseUrl, MIMO_ASR_API_KEY: pipeline.sttApiKey, MIMO_ASR_MODEL: pipeline.sttModel,
      MIMO_TTS_BASE_URL: runtimeConfig.mimoTtsBaseUrl, MIMO_TTS_API_KEY: pipeline.ttsApiKey, MIMO_TTS_MODEL: pipeline.ttsModel, MIMO_TTS_VOICE: pipeline.ttsVoice,
    }).active.signature,
    classifyError: message => /401|403|invalid.*key|unauthorized/i.test(message) ? 'fatal' : /another response is in progress/i.test(message) ? 'response_slot_busy' : /no active response/i.test(message) ? 'no_active_response' : 'other',
    buildSession: ({ agentContext, sessionOptions = {} }) => ({
      instructions: buildFrontendInstructions(agentContext),
      tools: frontendTools(agentContext).map(tool => tool.type === 'function' && tool.function ? { type: 'function', ...tool.function } : tool), modalities: modalities(),
      input_audio_format: 'pcm16', output_audio_format: 'pcm16', voice: sessionOptions.voice || profile().sessionDefaults.voice, turn_detection: profile().sessionDefaults.turnDetection,
    }),
    buildSpeakResponse: content => ({ conversation: 'none', modalities: modalities(), tool_choice: 'none', mimo_speak_text: String(content), instructions: speakResponseInstructions(content) }),
    buildResultInjection: (content, { allowTools = false } = {}) => ({ item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: String(content) }] }, response: { modalities: modalities(), tool_choice: allowTools ? 'auto' : 'none', instructions: resultResponseInstructions } }),
    buildPermissionInjection: permission => ({
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: ['<permission_request>', `permission_id=${permission.id}`, `task_id=${permission.taskId}`, `operation=${permission.summary}`, `allowed_decisions=${PERMISSION_DECISIONS.join(',')}`, '</permission_request>'].join('\n') }] },
      response: { modalities: modalities(), tool_choice: 'none', instructions: permissionResponseInstructions },
    }),
  }
}

export const mimoProvider = createMiMoRealtimeProvider()
