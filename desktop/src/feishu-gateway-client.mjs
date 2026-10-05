import { isLoopbackUrl } from './security.mjs'

export async function requestFeishuSettings({ baseUrl, accessToken = '', action = 'status', attemptId, fetchImpl = fetch, cookie = '', onCookie = () => {} } = {}) {
  if (!isLoopbackUrl(baseUrl)) throw new Error('飞书授权需在 Gateway 所在电脑完成。')
  const paths = { status: '/api/feishu/status', login: '/api/feishu/auth/login', complete: '/api/feishu/auth/complete' }
  if (!Object.hasOwn(paths, action)) throw new Error('无效的飞书设置操作。')
  if (action === 'complete' && (typeof attemptId !== 'string' || !/^[0-9a-f-]{36}$/i.test(attemptId))) throw new Error('请先连接飞书。')
  const origin = new URL(baseUrl).origin
  const response = await fetchImpl(`${origin}${paths[action]}`, {
    method: action === 'status' ? 'GET' : 'POST', redirect: 'error',
    headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...(action === 'status' ? {} : { 'content-type': 'application/json' }) },
    ...(action === 'status' ? {} : { body: JSON.stringify(action === 'complete' ? { attemptId } : {}) }),
    signal: AbortSignal.timeout(action === 'status' ? 20000 : 35000),
  })
  for (const header of response.headers.getSetCookie?.() || []) {
    const pair = header.split(';', 1)[0]
    if (pair.startsWith('qwen_audio_agent_identity=') && pair.length <= 8192) onCookie(pair)
  }
  if (!response.ok) throw new Error(response.status === 404 ? '当前 Gateway 尚未启用飞书功能。' : '飞书连接未完成，请检查授权后重试。')
  return response.json()
}

// Native settings run outside the renderer cookie store. Keep browser-mode
// identity in main-process memory, scoped to each trusted Gateway origin.
export function createFeishuSettingsClient({ fetchImpl = fetch } = {}) {
  const cookies = new Map()
  return options => {
    const origin = new URL(options.baseUrl).origin
    return requestFeishuSettings({ ...options, fetchImpl, cookie: cookies.get(origin), onCookie: value => {
      cookies.set(origin, value)
      if (cookies.size > 8) cookies.delete(cookies.keys().next().value)
    } })
  }
}
