import { randomUUID } from 'node:crypto'
import { spawnCli } from './cli.mjs'
import { resolveFeishuCli } from './cli-locator.mjs'

function authUrl(value) {
  const url = new URL(String(value || ''))
  if (url.protocol !== 'https:' || url.username || url.password || ![
    'feishu.cn', 'larksuite.com', 'larkoffice.com',
  ].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
    throw new Error('飞书返回了无效的授权地址。')
  }
  return url.href
}

function parseResult(result) {
  if (result.code !== 0) throw new Error('飞书授权未完成，请检查本机飞书 CLI 配置后重试。')
  try { return JSON.parse(result.stdout) }
  catch { throw new Error('飞书 CLI 没有返回有效的授权状态。') }
}

export function createFeishuAuthService({ config = {}, runner = spawnCli, resolveCli = resolveFeishuCli, now = Date.now } = {}) {
  const attempts = new Map()
  const controller = new AbortController()
  const command = async args => {
    try {
      return parseResult(await runner(resolveCli({ explicitPath: config.feishuCliPath }), args, {
        timeoutMs: 15000, maxBytes: 256 * 1024, signal: controller.signal,
      }))
    } catch {
      throw new Error('飞书授权操作未完成，请检查网络和本机飞书 CLI 配置后重试。')
    }
  }
  const expire = () => {
    for (const [key, value] of attempts) if (value.expiresAt <= now()) attempts.delete(key)
  }
  const status = async ({ verify = false } = {}) => {
    try { resolveCli({ explicitPath: config.feishuCliPath }) }
    catch { return { installed: false, ready: false, available: false, verified: false, status: 'cli_missing' } }
    try {
      const value = await command(['auth', 'status', '--json', ...(verify ? ['--verify'] : [])])
      const user = value.identities?.user || value.data?.identities?.user || {}
      const verified = user.verified === true || value.verified === true
      const state = ['ready', 'missing', 'expired', 'unavailable', 'unconfigured'].includes(user.status) ? user.status : 'unavailable'
      return {
        installed: true, status: state, available: user.available === true,
        verified, ready: state === 'ready' && user.available !== false && (!verify || verified),
      }
    } catch { return { installed: true, ready: false, available: false, verified: false, status: 'unavailable' } }
  }
  return {
    status,
    async login(ownerId) {
      if (!ownerId || typeof ownerId !== 'string') throw new Error('缺少飞书授权所属用户。')
      expire()
      const auth = await status({ verify: true })
      if (auth.ready) return { ready: true, auth }
      const previous = [...attempts.values()].find(value => value.ownerId === ownerId)
      if (previous) return { url: previous.url, attemptId: previous.attemptId, expiresAt: previous.expiresAt }
      if (attempts.size >= 4) throw new Error('已有飞书授权正在进行，请稍后重试。')
      const result = await command(['auth', 'login', '--domain', 'docs,drive,im,calendar,base,task', '--scope', 'im:message.send_as_user', '--no-wait', '--json'])
      const value = result.data || result
      if (typeof value.device_code !== 'string' || !value.device_code.length || value.device_code.length > 2048) throw new Error('飞书没有返回授权凭据。')
      const attemptId = randomUUID()
      const attempt = {
        attemptId, ownerId, deviceCode: value.device_code, url: authUrl(value.verification_url),
        expiresAt: now() + Math.min(600, Math.max(60, Number(value.expires_in) || 600)) * 1000,
      }
      attempts.set(attemptId, attempt)
      return { url: attempt.url, attemptId, expiresAt: attempt.expiresAt }
    },
    async complete(attemptId, ownerId) {
      expire()
      const attempt = attempts.get(attemptId)
      if (!attempt || attempt.ownerId !== ownerId) throw new Error('飞书授权已过期，请重新连接。')
      if (!attempt.pending) {
        attempt.pending = (async () => {
          await command(['auth', 'login', '--device-code', attempt.deviceCode, '--json'])
          const auth = await status({ verify: true })
          if (auth.ready) attempts.delete(attemptId)
          return auth
        })().finally(() => { attempt.pending = null })
      }
      return attempt.pending
    },
    close() { controller.abort(); attempts.clear() },
  }
}
