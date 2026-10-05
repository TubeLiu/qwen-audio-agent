import test from 'node:test'
import assert from 'node:assert/strict'
import { createFeishuAuthService } from '../src/feishu/auth-service.mjs'

const json = value => ({ code: 0, stdout: JSON.stringify(value), stderr: '' })
const ready = { identities: { user: { status: 'ready', available: true, verified: true, access_token: 'private-token' } } }
const missing = { identities: { user: { status: 'missing', available: false } } }

test('Feishu authentication reuses verified local authorization and returns no credentials', async () => {
  const commands = []
  const service = createFeishuAuthService({ resolveCli: () => 'mock-cli', runner: async (_path, args) => { commands.push(args); return json(ready) } })
  try {
    const result = await service.login('owner-1')
    assert.equal(result.ready, true)
    assert.equal(JSON.stringify(result).includes('private-token'), false)
    assert.equal(commands.some(args => args.includes('login')), false)
    assert.deepEqual(await service.status(), { installed: true, ready: true, available: true, verified: true, status: 'ready' })
  } finally { service.close() }
})

test('Feishu OAuth device code stays private, is owner-bound, expires and is consumed after verification', async () => {
  let authorized = false, clock = 1000
  const commands = []
  const service = createFeishuAuthService({ now: () => clock, resolveCli: () => 'mock-cli', runner: async (_path, args) => {
    commands.push(args)
    if (args.includes('status')) return json(authorized ? ready : missing)
    if (args.includes('--device-code')) { authorized = true; return json({ ok: true }) }
    return json({ ok: true, data: { verification_url: 'https://accounts.feishu.cn/open-apis/authen/authorize', device_code: 'private-device-code', expires_in: 60 } })
  } })
  try {
    const attempt = await service.login('owner-1')
    assert.equal(JSON.stringify(attempt).includes('private-device-code'), false)
    assert.equal(attempt.expiresAt, 61000)
    assert.deepEqual(await service.login('owner-1'), attempt)
    await assert.rejects(service.complete(attempt.attemptId, 'owner-2'), /过期/)
    const result = await service.complete(attempt.attemptId, 'owner-1')
    assert.equal(result.ready, true)
    await assert.rejects(service.complete(attempt.attemptId, 'owner-1'), /过期/)
    authorized = false
    const second = await service.login('owner-1')
    clock += 60001
    await assert.rejects(service.complete(second.attemptId, 'owner-1'), /过期/)
    const login = commands.find(args => args.includes('--no-wait'))
    assert.ok(login.includes('docs,drive,im,calendar,base,task'))
    assert.ok(login.includes('im:message.send_as_user'))
  } finally { service.close() }
})

test('Feishu authorization refuses untrusted external URLs and hides raw CLI failures', async () => {
  for (const verificationUrl of ['file:///private', 'https://evil.example/login', 'https://user:password@accounts.feishu.cn/']) {
    const service = createFeishuAuthService({ resolveCli: () => 'mock-cli', runner: async (_path, args) => json(args.includes('status') ? missing : { data: { verification_url: verificationUrl, device_code: 'private-code' } }) })
    try { await assert.rejects(service.login('owner-1'), /授权地址/) }
    finally { service.close() }
  }
  const failed = createFeishuAuthService({ resolveCli: () => 'mock-cli', runner: async () => ({ code: 1, stdout: '', stderr: 'private-token' }) })
  try {
    await assert.rejects(failed.login('owner-1'), error => !error.message.includes('private-token'))
    assert.equal((await failed.status()).ready, false)
  } finally { failed.close() }
})
