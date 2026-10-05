import { resolveFeishuCli } from './cli-locator.mjs'

// Feishu is an extra tool domain. It never changes the selected Qwen backend,
// memory, retrieval, provider registry, runtime paths or client configuration.
export function feishuConfiguration(config = {}, { locate = resolveFeishuCli } = {}) {
  const apiBaseUrl = String(config.feishuBaseUrl || config.mimoBaseUrl || '').replace(/\/+$/u, '')
  const inheritedBase = String(config.mimoBaseUrl || '').replace(/\/+$/u, '')
  let sameHost = !config.feishuBaseUrl
  try { sameHost ||= new URL(apiBaseUrl).origin === new URL(inheritedBase).origin } catch { /* not configured */ }
  const apiKey = config.feishuApiKey || (sameHost ? config.mimoApiKey : '') || ''
  let cliPath = '', cliIssue = ''
  try { cliPath = locate({ explicitPath: config.feishuCliPath }) }
  catch (error) { cliIssue = String(error.message || '飞书 CLI 尚未安装。') }
  return {
    enabled: config.feishuEnabled !== false, apiBaseUrl, apiKey,
    chatModel: config.feishuChatModel || config.mimoChatModel || '', cliPath, cliIssue,
    port: config.port || 3000, planTtlMs: 300000, cliTimeoutMs: 45000,
    aiTimeoutMs: 90000, timeZone: 'Asia/Shanghai', demo: false,
  }
}

export function publicConfiguration(config) {
  return { enabled: config.enabled !== false, configured: Boolean(config.apiBaseUrl && config.apiKey && config.chatModel),
    apiBaseUrl: config.apiBaseUrl, models: { chat: config.chatModel }, cliConfigured: Boolean(config.cliPath), cliIssue: config.cliIssue || '' }
}

export function redact(config, value) {
  let result = String(value)
  for (const secret of [config.apiKey, config.deviceToken].filter(Boolean)) result = result.split(secret).join('[REDACTED]')
  return result.replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, 'Bearer [REDACTED]')
}
