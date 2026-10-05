// MiMo HTTP audio is adapted to the Gateway's PCM16 16 kHz in / 24 kHz out.
// Endpoints are always used verbatim; TokenPlan is never silently rerouted.
export function pcm16ToWav(pcm, sampleRate = 16000) {
  if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2) throw new Error('PCM 音频参数不正确。')
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

export function decodeBase64Audio(value) {
  if (typeof value !== 'string' || !value.length || value.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4) throw new Error('语音服务返回的音频编码无效或过大。')
  const result = Buffer.from(value, 'base64')
  if (!result.length || result.toString('base64') !== value) throw new Error('语音服务返回的音频编码无效。')
  return result
}

export function redact(config, value) {
  let result = String(value)
  for (const secret of [config.apiKey, config.sttApiKey, config.ttsApiKey].filter(Boolean)) result = result.split(secret).join('[REDACTED]')
  return result.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
}

export function miMoChatOptions(config) {
  let host
  try { host = new URL(config.apiBaseUrl).hostname } catch { return {} }
  const models = new Set(['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed', 'mimo-v2.5-pro', 'mimo-v2.5'])
  return ['api.xiaomimimo.com', 'token-plan-cn.xiaomimimo.com'].includes(host) && models.has(config.chatModel)
    ? { thinking: { type: 'disabled' }, max_completion_tokens: 2048 } : {}
}
