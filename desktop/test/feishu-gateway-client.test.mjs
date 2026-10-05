import test from 'node:test'
import assert from 'node:assert/strict'
import { createFeishuSettingsClient, requestFeishuSettings } from '../src/feishu-gateway-client.mjs'
import { createServer } from 'node:http'
import { IdentityManager } from '../../server/src/core/identity.mjs'

test('native Feishu settings use fixed same-origin Gateway routes and the existing private bearer', async () => {
  const calls = []
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return Response.json({ auth: { ready: true } }) }
  const common = { baseUrl: 'http://127.0.0.1:3101', accessToken: 'private-gateway-key', fetchImpl }
  await requestFeishuSettings(common)
  await requestFeishuSettings({ ...common, action: 'complete', attemptId: '00000000-0000-4000-8000-000000000001' })
  assert.equal(calls[0].url, `${common.baseUrl}/api/feishu/status`)
  assert.equal(calls[1].options.method, 'POST')
  assert.equal(calls[1].options.headers.Origin, common.baseUrl)
  assert.equal(calls[1].options.headers.Authorization, 'Bearer private-gateway-key')
  assert.equal(calls[1].options.redirect, 'error')
  assert.deepEqual(JSON.parse(calls[1].options.body), { attemptId: '00000000-0000-4000-8000-000000000001' })
})

test('native Feishu settings cannot invoke remote or arbitrary routes, and invalid attempts never reach fetch', async () => {
  const fetchImpl = async () => { throw new Error('Invalid settings action reached network') }
  await assert.rejects(requestFeishuSettings({ baseUrl: 'https://evil.example', fetchImpl }), /所在电脑/)
  await assert.rejects(requestFeishuSettings({ baseUrl: 'http://127.0.0.1:3101', action: '/arbitrary', fetchImpl }), /无效/)
  await assert.rejects(requestFeishuSettings({ baseUrl: 'http://127.0.0.1:3101', action: 'complete', attemptId: 'private-device-code', fetchImpl }), /连接飞书/)
})

test('browser-mode native Feishu login and completion keep one private identity without exposing cookies to the renderer', async () => {
  const identity = new IdentityManager({ secret: 'isolated-browser-identity-secret-0123456789', mode: 'browser' })
  const attemptId = '00000000-0000-4000-8000-000000000001'
  let owner
  const server = createServer((req, res) => {
    const current = identity.resolveHttp(req, res)
    res.setHeader('content-type', 'application/json')
    if (req.url.endsWith('/login')) { owner = current.ownerId; res.end(JSON.stringify({ attemptId })) }
    else { res.statusCode = owner === current.ownerId ? 200 : 403; res.end(JSON.stringify({ auth: { ready: owner === current.ownerId } })) }
  })
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady))
  try {
    const request = createFeishuSettingsClient()
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    const login = await request({ baseUrl, action: 'login' })
    const completed = await request({ baseUrl, action: 'complete', attemptId: login.attemptId })
    assert.equal(completed.auth.ready, true)
    assert.equal(JSON.stringify({ login, completed }).includes('qwen_audio_agent_identity'), false)
    await assert.rejects(requestFeishuSettings({ baseUrl, action: 'complete', attemptId }), /未完成/)
  } finally { await new Promise(resolveClosed => server.close(resolveClosed)) }
})
