import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { FeishuWorkService } from '../src/feishu/work-service.mjs'
import { FeishuFrontendToolSource } from '../src/feishu/frontend-source.mjs'
import { feishuConfiguration } from '../src/feishu/config.mjs'

const bootstrap = mkdtempSync(join(tmpdir(), 'native-feishu-bootstrap-'))
const environment = { QWAUDIO_CONFIG_DIR: join(bootstrap, 'config'), QWAUDIO_DATA_DIR: join(bootstrap, 'data'),
  QWAUDIO_STATE_DIR: join(bootstrap, 'state'), QWAUDIO_CACHE_DIR: join(bootstrap, 'cache'), QWAUDIO_WORKSPACE: join(bootstrap, 'workspace'),
  QWEN_AUDIO_AGENT_AUTH_SECRET: 'isolated-mock-auth-secret-over-thirty-two-characters' }
const previousEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
Object.assign(process.env, environment)
const [{ config: defaults }, { createGatewayApplication }, { createRealtimeProviderRegistry }, { createMiMoRealtimeProvider },
  { createMiMoRealtimeBridge }, { ConversationSync }, { GatewayClient }, { TaskManager }, { TaskStore }] = await Promise.all([
  import('../src/core/config.mjs'), import('../src/app/gateway-application.mjs'), import('../src/voice/realtime-provider-extension.mjs'),
  import('../src/voice/providers/mimo.mjs'), import('../src/voice/providers/mimo-bridge.mjs'), import('../src/conversation/conversation-sync.mjs'),
  import('../../shared/gateway/client-sdk.mjs'), import('../src/task/task-manager.mjs'),
  import('../src/task/task-store.mjs'),
])
for (const [key, value] of Object.entries(previousEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
test.after(() => rmSync(bootstrap, { recursive: true, force: true }))

const owner = { ownerId: 'user_native_feishu', sessionId: 'main' }
const sleep = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))
async function until(check, timeout = 7000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = check(); if (value) return value; await sleep(10) }
  throw new Error('Native Feishu integration did not reach the expected state.')
}
const jsonReply = content => Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] })

function nativeBackend(calls) {
  return {
    enabled: true, describe: () => ({ configured: true, enabled: true, protocol: 'acp', label: 'Original native backend', capabilities: {} }),
    start: async () => ({ ok: true }), health: async () => ({ ok: true }), status: () => ({ state: 'ready' }),
    submit: async work => { calls.push(work); return { content: '原有通用后台功能已完成。' } },
    cancel: async () => ({ state: 'cancelled' }), respondAuthorization: async () => ({}), respondInput: async () => ({}),
    subscribe: () => () => {}, close: async () => {}, canRecoverDelegatedWork: () => false, recoverDelegatedWork: async () => null,
  }
}

async function fixture({ write = false, defaultBackendDisabled = false, restoredTasks = null, voiceOutput = false, speechFailure = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'native-feishu-'))
  const previousBackendProtocol = defaults.agentProtocol
  if (defaultBackendDisabled) defaults.agentProtocol = ''
  const config = { ...defaults, host: '127.0.0.1', port: 0, audioProvider: 'test-mimo',
    identityMode: 'personal', personalOwnerId: owner.ownerId, authSecret: 'mock-auth-secret-over-thirty-two-characters',
    gatewayAccessToken: '', gatewayAccessKeys: '', gatewayDeviceStatePath: join(directory, 'devices.json'),
    dataDirectory: join(directory, 'data'), stateDirectory: join(directory, 'state'), cacheDirectory: join(directory, 'cache'),
    taskStatePath: join(directory, 'tasks.json'), backendSessionStatePath: join(directory, 'backend.json'), frontendNotesPath: join(directory, 'notes.json'),
    memoryAutoEnabled: false, memoryApiKey: '', preferenceLearningEnabled: false, sessionDigestEnabled: false, domainLibraryEnabled: false,
    frontendMemoryPath: join(directory, 'MEMORY.md'), userModelPath: join(directory, 'USER.md'), memoryAuditPath: join(directory, 'audit.jsonl'),
    frontendMcpConfigPath: '', frontendOpenApiConfigPath: '', webSearchProvider: 'none', webSearchMcpUrl: '',
    feishuEnabled: true, feishuBaseUrl: 'https://mock.invalid/v1', feishuApiKey: 'mock-feishu-key', feishuChatModel: 'mock-chat', feishuCliPath: '',
    mimoBaseUrl: 'https://mock.invalid/v1', mimoApiKey: 'mock-chat-key', mimoChatModel: 'mock-chat',
    mimoAsrBaseUrl: 'https://mock.invalid/v1', mimoAsrApiKey: 'mock-asr-key', mimoAsrModel: 'mimo-v2.5-asr',
    mimoTtsBaseUrl: 'https://mock.invalid/v1', mimoTtsApiKey: 'mock-tts-key', mimoTtsModel: 'mimo-v2.5-tts', mimoTtsVoice: 'mimo_default',
  }
  const text = write ? '发送消息到 oc_native：今天完成评审。' : '查看我的飞书任务'
  const plan = write ? { kind: 'write', steps: [{ tool: 'messages.send', args: { chatId: 'oc_native', text: '今天完成评审。' } }] }
    : { kind: 'read', steps: [{ tool: 'tasks.list', args: {} }] }
  const requests = [], cliCalls = [], nativeCalls = [], events = []
  const fetcher = async (url, init) => {
    assert.equal(url, 'https://mock.invalid/v1/chat/completions'); assert.equal(init.redirect, 'error')
    const body = JSON.parse(init.body); requests.push(body)
    if (body.response_format) return jsonReply(JSON.stringify(plan))
    if (body.model === config.mimoTtsModel) {
      const frame = (speechFailure === 'empty' ? '' : `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: Buffer.alloc(960).toString('base64') } } }] })}\n\n`)
        + (speechFailure ? `data: ${JSON.stringify({ error: { message: 'mock speech segment failed' } })}\n\n` : 'data: [DONE]\n\n')
      return new Response(frame, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (!body.tools && body.messages[0].content.includes('这是飞书写入操作等待本次按钮确认的通知')) {
      return jsonReply('飞书写入尚未执行，请在本应用对话面板查看完整预览，再点击确认执行本次操作。')
    }
    if (!body.tools && body.messages.some(message => String(message.content).includes('task_id:') && String(message.content).includes('准备评审'))) {
      return jsonReply('飞书查询完成：有一项待办，准备评审。')
    }
    if (!body.tools) return jsonReply('飞书结果已整理。')
    if (!body.messages.some(message => message.tool_calls?.some(call => call.function?.name === 'feishu_submit'))) {
      return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function', function: { name: 'feishu_submit', arguments: JSON.stringify({ objective: text }) } }] } }] })
    }
    return jsonReply(write ? '飞书写入请求已受理，生成本应用的完整预览后才能点击执行。'
      : '正在直接查询飞书任务，查询无需确认；结果返回后会告诉你。')
  }
  const bridgeToken = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
  const bridge = createMiMoRealtimeBridge({ config: { apiBaseUrl: config.mimoBaseUrl, apiKey: config.mimoApiKey, chatModel: config.mimoChatModel,
    sttProvider: 'mimo', sttBaseUrl: config.mimoAsrBaseUrl, sttApiKey: config.mimoAsrApiKey, sttModel: config.mimoAsrModel,
    ttsBaseUrl: config.mimoTtsBaseUrl, ttsApiKey: config.mimoTtsApiKey, ttsModel: config.mimoTtsModel, ttsVoice: config.mimoTtsVoice },
  WebSocketServer, bridgeToken, port: 0, fetcher, paced: false })
  await bridge.listen()
  const provider = createMiMoRealtimeProvider({ runtimeConfig: config, connection: () => ({ url: `ws://127.0.0.1:${bridge.server.address().port}/realtime`, token: bridgeToken }) })
  const agent = nativeBackend(nativeCalls)
  if (restoredTasks) writeFileSync(config.taskStatePath, JSON.stringify({ version: 1, nextTaskNumber: 100, tasks: restoredTasks }))
  const application = createGatewayApplication({ config, ...(defaultBackendDisabled ? {} : { agent }), autoStart: false, parentPort: null, publicEndpoint: null,
    conversationSync: new ConversationSync(), realtimeProviderRegistry: createRealtimeProviderRegistry({ providers: [{ ...provider, key: 'test-mimo' }], defaultProvider: 'test-mimo' }), realtimeProvider: 'test-mimo' })
  const work = application.services.feishu.work
  work.fetcher = fetcher
  work.runner = async (_file, args) => {
    if (args[0] === 'auth') return { code: 0, stdout: JSON.stringify({ identities: { user: { available: true, verified: true, openId: 'ou_native' } } }), stderr: '' }
    cliCalls.push(args)
    return { code: 0, stdout: JSON.stringify({ ok: true, identity: 'user', data: write ? { message_id: 'om_native' } : { items: [{ summary: '准备评审' }] } }), stderr: '' }
  }
  application.start(); await until(() => application.server.listening)
  const base = `http://127.0.0.1:${application.server.address().port}`
  const playing = new Set()
  const client = new GatewayClient({ url: base.replace('http:', 'ws:') + '/api/realtime', createSocket: target => new WebSocket(target),
    clientType: 'test', clientInstanceId: randomUUID(), capabilities: ['input.text', 'tasks.commands', 'tasks.input.respond', 'permissions.respond', 'playback.receipts'],
    configure: { textOnly: !voiceOutput, voiceEnabled: voiceOutput, inputEnabled: false, outputEnabled: voiceOutput, provider: 'test-mimo' }, reconnect: false,
    onEvent: event => {
      events.push(event)
      if (event.type === 'audio.delta' && !playing.has(event.responseId)) { playing.add(event.responseId); client.send({ type: 'playback.started', responseId: event.responseId }) }
      if (event.type === 'audio.done' && playing.has(event.responseId)) client.send({ type: 'playback.ended', responseId: event.responseId })
    } })
  client.start(); await until(() => client.ready)
  return { directory, config, application, work, client, requests, cliCalls, nativeCalls, events, base, text,
    async post(path, body, origin = base) { return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) }) },
    async close() { client.close(); await application.close(); await bridge.close(); defaults.agentProtocol = previousBackendProtocol; rmSync(directory, { recursive: true, force: true }) } }
}

test('native frontend adds Feishu beside original agent tools and runs its typed read through the genuine TaskManager', async () => {
  const f = await fixture()
  try {
    f.client.send({ type: 'text.message', text: f.text })
    const completed = await until(() => f.application.services.taskManager.list(owner).find(task => task.kind === 'feishu' && task.status === 'completed'))
    assert.match(completed.result, /飞书结果已整理/); assert.equal(f.cliCalls.length, 1); assert.equal(f.nativeCalls.length, 0)
    const chat = f.requests.find(body => body.tools)
    const names = chat.tools.map(tool => tool.function.name)
    for (const name of ['spawn_thinking', 'get_current_time', 'schedule_reminder', 'feishu_submit']) assert.ok(names.includes(name), `${name} must remain available`)
    assert.ok(f.application.services.frontendMemory, 'the original memory module is still mounted')
    assert.ok(f.application.services.frontendMcp, 'the original MCP client is still mounted')
    assert.ok(f.application.services.frontendOpenApi, 'the original OpenAPI adapter is still mounted')
    assert.ok(f.application.services.frontendRetrieval, 'the original search/retrieval service is still mounted')
    const source = f.work.sources.get(completed.id)
    assert.equal(source, undefined, 'completed sources are released')
    assert.equal(f.work.userTurns.get(`${owner.ownerId}\0main`).text, f.text, 'native input commit is the trusted source; bridge hook is unused')
    await until(() => f.events.some(event => event.type === 'task.running') && f.events.some(event => event.type === 'task.completed'))
    const nativeTask = f.application.services.taskOperations.submit({ objective: '运行原有通用后台工作' }, owner)
    await until(() => f.application.services.taskManager.get(nativeTask.id, owner).status === 'completed')
    assert.equal(f.nativeCalls.length, 1); assert.match(f.nativeCalls[0].objective, /原有通用后台/)
  } finally { await f.close() }
})

test('native Feishu plan requires the full-preview button receipt, rejects voice/always and executes once beside a live original backend', async () => {
  const f = await fixture({ write: true })
  try {
    f.client.send({ type: 'text.message', text: f.text })
    const pending = await until(() => f.work.pending(owner)[0])
    assert.equal(f.cliCalls.length, 0)
    const task = f.application.services.taskManager.get(pending.taskId, owner)
    assert.equal(task.kind, 'feishu'); assert.equal(task.inputRequest.kind, 'authorization')
    await assert.rejects(f.application.services.taskOperations.respondToInput(task.id, pending.planId, { action: 'accept', text: '好的，始终允许' }, owner), /按钮/)
    assert.throws(() => f.application.services.taskOperations.submitPermission(pending.planId, 'always', owner), /permission request not found/)
    const original = f.application.services.taskOperations.submit({ objective: '保留通用后台并行处理' }, owner)
    await until(() => f.application.services.taskManager.get(original.id, owner).status === 'completed')
    assert.equal(f.nativeCalls.length, 1); assert.equal(f.cliCalls.length, 0)
    const route = `/api/feishu/plans/${pending.planId}`
    const preview = await (await fetch(f.base + route)).json()
    assert.equal(preview.preview, pending.preview); assert.match(preview.preview, /oc_native/); assert.ok(preview.reviewToken)
    assert.equal((await f.post(route + '/confirm', { reviewed: true })).status, 400)
    assert.equal((await f.post(route + '/confirm', { reviewed: true, reviewToken: preview.reviewToken }, 'https://attacker.invalid')).status, 403)
    assert.equal(f.cliCalls.length, 0)
    const body = { taskId: task.id, reviewed: true, reviewToken: preview.reviewToken }
    const [first, duplicate] = await Promise.all([f.post(route + '/confirm', body), f.post(route + '/confirm', body)])
    assert.equal(first.status, 200); assert.deepEqual(await first.json(), await duplicate.json()); assert.equal(f.cliCalls.length, 1)
    await until(() => f.application.services.taskManager.get(task.id, owner).status === 'completed')
  } finally { await f.close() }
})

test('native typed Feishu work binds the exact owner/session/turn and preserves the queued user instruction', async () => {
  const config = { apiBaseUrl: 'https://mock.invalid/v1', apiKey: 'mock', chatModel: 'mock', cliPath: 'mock-cli', planTtlMs: 5000, cliTimeoutMs: 1000, aiTimeoutMs: 1000, demo: false }
  const calls = []
  const work = new FeishuWorkService(config, { fetcher: async (_url, init) => {
    const body = JSON.parse(init.body)
    return jsonReply(body.response_format ? JSON.stringify({ kind: 'write', steps: [{ tool: 'messages.send', args: { chatId: 'oc_native', text: '今天完成评审。' } }] }) : 'done')
  }, runner: async (_file, args) => { if (args[0] !== 'auth') calls.push(args); return { code: 0, stderr: '', stdout: JSON.stringify(args[0] === 'auth' ? { identities: { user: { available: true } } } : { ok: true, data: {} }) } } })
  const taskManager = new TaskManager()
  const source = new FeishuFrontendToolSource({ work, taskManager })
  try {
    work.recordUserText({ ...owner, turnId: 'real-turn', text: '查看文档' })
    const forged = await source.execute('feishu_submit', { objective: '发送消息' }, { ...owner, sessionId: 'other', turnId: 'real-turn' })
    await until(() => taskManager.get(forged.taskId, owner)?.status === 'failed')
    assert.equal(work.pending(owner).length, 0); assert.equal(calls.length, 0)
    work.recordUserText({ ...owner, turnId: 'write-turn', text: '发送消息到 oc_native：今天完成评审。' })
    const accepted = await source.execute('feishu_submit', { objective: '发送消息' }, { ...owner, turnId: 'write-turn' })
    work.recordUserText({ ...owner, turnId: 'later-turn', text: '现在只查询任务进度' })
    const preview = await until(() => work.pending(owner)[0])
    assert.equal(preview.taskId, accepted.taskId); assert.match(preview.preview, /今天完成评审/)
    assert.throws(() => work.getPreview(preview.planId, { ownerId: 'user_other' }), /不属于/)
    await taskManager.cancel(accepted.taskId, owner); assert.equal(calls.length, 0)
  } finally { await work.close() }
})

test('Feishu configuration never moves an inherited MiMo key to another explicit API host', () => {
  const locate = () => '/mock/native/lark-cli'
  const config = { mimoBaseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', mimoApiKey: 'private-mock', mimoChatModel: 'mimo-v2.6-flash' }
  assert.equal(feishuConfiguration(config, { locate }).apiKey, 'private-mock')
  assert.equal(feishuConfiguration({ ...config, feishuBaseUrl: 'https://other.invalid/v1' }, { locate }).apiKey, '')
  assert.equal(feishuConfiguration({ ...config, feishuBaseUrl: 'https://other.invalid/v1', feishuApiKey: 'separate-mock' }, { locate }).apiKey, 'separate-mock')
})

test('native clarification resumes the same Feishu task from a fresh real turn, ignoring model-substituted text', async () => {
  const f = await fixture()
  const plannedTexts = []
  try {
    f.work.fetcher = async (_url, init) => {
      const body = JSON.parse(init.body)
      if (!body.response_format) return jsonReply('done')
      plannedTexts.push(body.messages.at(-1).content)
      return jsonReply(JSON.stringify(plannedTexts.length === 1 ? { kind: 'clarification', question: '日程标题、开始时间和时长是什么？' }
        : { kind: 'write', steps: [{ tool: 'calendar.create', args: { summary: '产品评审', start: '2026-10-06T15:00:00+08:00', end: '2026-10-06T16:00:00+08:00' } }] }))
    }
    f.client.send({ type: 'text.message', text: '创建一个日程' })
    const task = await until(() => f.application.services.taskManager.list(owner).find(value => value.kind === 'feishu' && value.inputRequest?.kind === 'input'))
    const inputId = task.inputRequest.id
    await assert.rejects(f.application.services.taskOperations.respondToInput(task.id, inputId, { action: 'accept', text: '模型编造的标题与时间' }, owner), /真实用户回答/)
    f.client.send({ type: 'text.message', text: '明天三点产品评审一小时' })
    await until(() => f.work.userTurns.get(`${owner.ownerId}\0main`)?.text === '明天三点产品评审一小时')
    await f.application.services.taskOperations.respondToInput(task.id, inputId, { action: 'accept', text: '模型替换成今天' }, owner)
    const preview = await until(() => f.work.pending(owner)[0])
    assert.equal(preview.taskId, task.id); assert.match(preview.preview, /产品评审/)
    assert.deepEqual(plannedTexts, ['创建一个日程', '明天三点产品评审一小时'])
    assert.equal(f.cliCalls.length, 0)
    await f.application.services.taskOperations.cancel(task.id, owner)
    assert.equal(f.application.services.taskManager.get(task.id, owner).status, 'cancelled')
  } finally { await f.close() }
})

test('native cancellation aborts an in-flight Feishu CLI operation and releases its real task lane', async () => {
  const f = await fixture(); let querySignal
  const original = f.work.runner
  try {
    f.work.runner = async (file, args, options) => {
      if (args[0] === 'auth') return original(file, args, options)
      querySignal = options.signal
      return new Promise((_yes, no) => options.signal.addEventListener('abort', () => no(options.signal.reason), { once: true }))
    }
    f.client.send({ type: 'text.message', text: f.text })
    const task = await until(() => querySignal && f.application.services.taskManager.list(owner).find(value => value.kind === 'feishu'))
    await f.application.services.taskOperations.cancel(task.id, owner)
    assert.equal(querySignal.aborted, true)
    assert.equal(f.application.services.taskManager.get(task.id, owner).status, 'cancelled')
    assert.equal(f.work.active.size, 0)
    assert.equal(f.work.owners.get(`${owner.ownerId}\0main`).current, null)
  } finally { await f.close() }
})

for (const termination of ['cancel', 'failure', 'expiry']) {
  test(`a ${termination} during native Feishu clarification clears write intent before a later actionless turn`, async () => {
    const f = await fixture(); let plans = 0
    try {
      if (termination === 'expiry') f.work.config.planTtlMs = 60
      f.work.fetcher = async (_url, init) => {
        const body = JSON.parse(init.body)
        if (!body.response_format) return jsonReply('done')
        plans++
        if (plans === 1 && termination === 'failure') throw new Error('mock planner failure')
        return jsonReply(JSON.stringify(plans === 1 ? { kind: 'clarification', question: '请补充日程时间与标题。' }
          : { kind: 'write', steps: [{ tool: 'calendar.create', args: { summary: '产品评审', start: '2026-10-06T15:00:00+08:00', end: '2026-10-06T16:00:00+08:00' } }] }))
      }
      f.client.send({ type: 'text.message', text: '创建一个日程' })
      const first = await until(() => f.application.services.taskManager.list(owner).find(value => value.kind === 'feishu'))
      if (termination === 'cancel') {
        await until(() => f.application.services.taskManager.get(first.id, owner).inputRequest?.kind === 'input')
        await f.application.services.taskOperations.cancel(first.id, owner)
      } else await until(() => f.application.services.taskManager.get(first.id, owner).status === 'failed')
      const context = f.work.owners.get(`${owner.ownerId}\0main`)
      assert.equal([...context.assistant.sessions.values()][0].activeWriteIntent, null)
      f.client.send({ type: 'text.message', text: '明天下午三点产品评审一小时' })
      const input = await until(() => { const value = f.work.userTurns.get(`${owner.ownerId}\0main`); return value?.text === '明天下午三点产品评审一小时' && value })
      const second = await f.application.services.feishu.source.execute('feishu_submit', { objective: '安排产品评审' }, { ...owner, turnId: input.turnId })
      await until(() => f.application.services.taskManager.get(second.taskId, owner).inputRequest?.kind === 'input')
      assert.equal(f.work.pending(owner).length, 0, 'an old cancelled request cannot authorize a new write preview')
      assert.equal(f.cliCalls.length, 0)
      await f.application.services.taskOperations.cancel(second.taskId, owner)
    } finally { await f.close() }
  })
}

for (const write of [false, true]) {
  test(`actual default frontend-only backend still schedules independent Feishu ${write ? 'preview and once-only confirmed write' : 'read'}`, async () => {
    const f = await fixture({ defaultBackendDisabled: true, write })
    try {
      assert.equal(f.application.services.agent.enabled, false)
      assert.equal(f.application.services.agent.status().status, 'not_configured')
      f.client.send({ type: 'text.message', text: f.text })
      const task = await until(() => f.application.services.taskManager.list(owner).find(value => value.kind === 'feishu' && value.status !== 'queued'))
      const names = f.requests.find(body => body.tools).tools.map(tool => tool.function.name)
      assert.equal(names.includes('spawn_thinking'), false, 'the original unconfigured backend remains unavailable')
      assert.equal(names.includes('feishu_submit'), true, 'independent Feishu is not gated by that backend')
      if (write) {
        const pending = await until(() => f.work.pending(owner)[0])
        assert.equal(f.cliCalls.length, 0)
        const route = `/api/feishu/plans/${pending.planId}`
        const preview = await (await fetch(f.base + route)).json()
        const response = await f.post(route + '/confirm', { taskId: task.id, reviewed: true, reviewToken: preview.reviewToken })
        assert.equal(response.status, 200)
      }
      await until(() => f.application.services.taskManager.get(task.id, owner).status === 'completed')
      assert.equal(f.cliCalls.length, 1)
    } finally { await f.close() }
  })
}

test('restart fails closed for persisted running and queued Feishu tasks without replay or retaining a scheduler slot', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'feishu-restart-'))
  const store = new TaskStore({ filePath: join(directory, 'tasks.json') })
  const old = new TaskManager({ store })
  let release
  const first = old.create({ ...owner, kind: 'feishu', objective: 'mock old Feishu work', laneKey: 'feishu-old', runner: async (_objective, { onEvent }) => {
    onEvent({ type: 'backend.input.requested', input: { id: randomUUID(), kind: 'authorization', mode: 'url', prompt: 'mock full preview', url: 'http://localhost/preview', status: 'pending' } })
    return new Promise(yes => { release = yes })
  } })
  await until(() => old.get(first.id, owner).status === 'running')
  const queued = old.create({ ...owner, kind: 'feishu', objective: 'mock old queued work', laneKey: 'feishu-old', runner: async () => { throw new Error('A queued old write must never replay.') } })
  await store.flush()
  const persisted = store.load()
  assert.equal(persisted.find(task => task.id === queued.id).status, 'queued')
  let f
  try {
    f = await fixture({ defaultBackendDisabled: true, restoredTasks: persisted })
    for (const accepted of [first, queued]) {
      const task = f.application.services.taskManager.get(accepted.id, owner)
      assert.equal(task.status, 'failed'); assert.equal(task.inputRequest, null)
      assert.equal(f.application.services.taskManager.tasks.get(task.id).runner, null)
    }
    assert.equal(f.work.active.size, 0); assert.equal(f.cliCalls.length, 0)
    f.client.send({ type: 'text.message', text: f.text })
    await until(() => f.application.services.taskManager.list(owner).find(task => ![first.id, queued.id].includes(task.id) && task.status === 'completed'))
    assert.equal(f.cliCalls.length, 1, 'new independent work must start after old unrecoverable tasks have failed')
  } finally {
    release({ content: 'mock old process shutdown' })
    await old.tasks.get(first.id).promise
    await old.tasks.get(queued.id).promise
    await store.flush()
    await f?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Feishu acceptance distinguishes queue admission from a real confirmation and completed reuse', async () => {
  const taskManager = new TaskManager()
  const work = { bindTaskSource() {}, submit: async () => ({ content: 'mock completed read' }), cancel: async () => ({}) }
  const source = new FeishuFrontendToolSource({ taskManager, work })
  const context = { ...owner, turnId: 'admission-turn' }
  const first = await source.execute('feishu_submit', { objective: '只读查询' }, context)
  assert.equal(first.state, 'queued'); assert.equal(first.confirmationReady, false); assert.equal(first.resultReady, false)
  assert.equal(first.nextAction, 'wait_for_task_events'); assert.equal(first.readPolicy, 'execute_without_confirmation')
  assert.match(first.message, /尚无查询结果或确认预览/); assert.match(first.message, /查询直接执行、无需确认/)
  await until(() => taskManager.get(first.taskId, owner).status === 'completed')
  const duplicate = await source.execute('feishu_submit', { objective: '重复只读查询' }, context)
  assert.equal(duplicate.status, 'existing'); assert.equal(duplicate.state, 'completed'); assert.equal(duplicate.confirmationReady, false)
  assert.equal(duplicate.resultReady, true); assert.equal(duplicate.nextAction, 'report_actual_result')
  assert.equal(duplicate.result, 'mock completed read'); assert.match(duplicate.message, /不会重复提交/)
  const description = source.tools()[0].definition.function.description
  assert.match(description, /查询会直接执行，无需确认/)
  assert.match(description, /不得要求用户去飞书官网查看预览/)
  assert.match(description, /创建云文档并写入完整正文、向已有文档文末追加/)
})

test('a native frontend-only read delivers its actual result and PCM announcement on the same active voice connection without confirmation', async () => {
  const f = await fixture({ defaultBackendDisabled: true, voiceOutput: true })
  try {
    assert.equal(f.application.services.agent.enabled, false)
    f.client.send({ type: 'text.message', text: f.text })
    const completed = await until(() => f.application.services.taskManager.list(owner).find(task => task.kind === 'feishu' && task.status === 'completed'))
    assert.match(completed.result, /准备评审/)
    assert.equal(f.work.pending(owner).length, 0)
    assert.equal(f.events.some(event => event.type === 'task.input.requested' && event.task?.inputRequest?.kind === 'authorization'), false)
    const announcement = await until(() => f.events.find(event => event.type === 'response.started' && event.origin === 'announcement'
      && (event.taskId === completed.id || event.taskIds?.includes(completed.id))))
    const transcript = await until(() => f.events.find(event => event.type === 'transcript.final' && event.responseId === announcement.responseId
      && event.role === 'assistant' && String(event.content).includes('准备评审')))
    assert.match(transcript.content, /查询完成/)
    const done = await until(() => f.events.find(event => event.type === 'audio.done' && event.responseId === announcement.responseId))
    assert.equal(done.turnId, announcement.turnId)
    assert.ok(f.events.some(event => event.type === 'audio.delta' && event.responseId === announcement.responseId && Buffer.from(event.audio, 'base64').length > 0))
    await until(() => f.application.services.taskManager.get(completed.id, owner).notificationStatus === 'delivered')
    assert.equal(f.client.ready, true, 'no reconnect is needed to receive the final result')
    assert.equal(f.cliCalls.length, 1)
    assert.deepEqual(f.cliCalls[0].slice(0, 2), ['task', '+get-my-tasks'])
    const receipt = f.requests.flatMap(body => body.messages || []).find(message => message.role === 'tool')
    const accepted = JSON.parse(receipt.content)
    assert.equal(accepted.confirmationReady, false); assert.equal(accepted.resultReady, false)
    assert.equal(accepted.nextAction, 'wait_for_task_events'); assert.equal(accepted.readPolicy, 'execute_without_confirmation')
  } finally { await f.close() }
})

test('a long document goal and completed result cannot turn a valid Feishu receipt into a frontend size error', async () => {
  const taskManager = new TaskManager()
  const fullObjective = '创建文档：' + '📘'.repeat(1990)
  const fullResult = '📄'.repeat(4000)
  const source = new FeishuFrontendToolSource({ taskManager,
    work: { bindTaskSource() {}, submit: async () => ({ content: fullResult }), cancel: async () => ({}) } })
  const context = { ...owner, turnId: 'large-admission-turn' }
  const accepted = await source.execute('feishu_submit', { objective: fullObjective }, context)
  assert.equal(accepted.objectiveTruncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(accepted)) < 4096)
  await until(() => taskManager.get(accepted.taskId, owner).status === 'completed')
  const duplicate = await source.execute('feishu_submit', { objective: fullObjective }, context)
  assert.equal(duplicate.resultReady, true); assert.equal(duplicate.resultTruncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(duplicate)) < 4096)
  assert.equal(taskManager.get(accepted.taskId, owner).objective, fullObjective)
  assert.equal(taskManager.get(accepted.taskId, owner).result, fullResult)
})

test('actual native Feishu authorization notice uses this application button instructions without generic voice approval', async () => {
  const f = await fixture({ defaultBackendDisabled: true, write: true, voiceOutput: true })
  try {
    f.client.send({ type: 'text.message', text: f.text })
    const pending = await until(() => f.work.pending(owner)[0])
    const notice = await until(() => f.requests.find(body => !body.tools
      && body.messages[0].content.includes('这是飞书写入操作等待本次按钮确认的通知')))
    const instructions = notice.messages[0].content
    assert.match(instructions, /本应用对话面板查看完整预览/)
    assert.match(instructions, /不要询问是否批准/)
    assert.match(instructions, /不要调用 respond_agent_input、respond_permission/)
    assert.doesNotMatch(instructions, /用户回答后调用 respond_agent_input|询问是否批准并停止输出|respond_agent_input 的 decline 拒绝当前预览/)
    const task = f.application.services.taskManager.get(pending.taskId, owner)
    assert.match(task.inputRequest.prompt, /本应用对话面板查看完整预览/)
    assert.doesNotMatch(task.inputRequest.prompt, /设备|按 OK|打开链接/)
    const response = await until(() => f.events.find(event => event.type === 'response.started' && event.origin === 'backend-input'
      && event.taskId === task.id))
    const spoken = await until(() => f.events.find(event => event.type === 'transcript.final' && event.responseId === response.responseId))
    assert.match(spoken.content, /本应用对话面板查看完整预览/)
    assert.equal(f.cliCalls.length, 0, 'an authorization notification never executes the write')
    await f.application.services.taskOperations.cancel(task.id, owner)
  } finally { await f.close() }
})

for (const speechFailure of [true, 'empty']) {
test(`a genuine MiMo ${speechFailure === true ? 'partial' : 'zero PCM'} TTS failure reaches the SDK client while its Feishu result finishes without replay`, async () => {
  const f = await fixture({ defaultBackendDisabled: true, voiceOutput: true, speechFailure })
  try {
    f.client.send({ type: 'text.message', text: f.text })
    const completed = await until(() => f.application.services.taskManager.list(owner).find(task => task.kind === 'feishu' && task.status === 'completed'))
    const announcement = await until(() => f.events.find(event => event.type === 'response.started' && event.origin === 'announcement'
      && (event.taskId === completed.id || event.taskIds?.includes(completed.id))))
    const notice = await until(() => f.events.find(event => event.type === 'error' && event.code === 'speech_synthesis_failed'
      && event.responseId === announcement.responseId))
    assert.equal(notice.taskId, completed.id); assert.equal(notice.turnId, announcement.turnId)
    assert.match(notice.message, /可能只有一部分/); assert.doesNotMatch(notice.message, /mock speech segment failed/)
    await until(() => f.events.some(event => event.type === 'audio.done' && event.responseId === announcement.responseId))
    await until(() => f.application.services.taskManager.get(completed.id, owner).notificationStatus === 'delivered')
    assert.ok(f.events.some(event => event.type === 'transcript.final' && event.responseId === announcement.responseId && event.content.includes('准备评审')))
    assert.equal(f.cliCalls.length, 1); assert.equal(f.work.pending(owner).length, 0)
    if (speechFailure === 'empty') assert.equal(f.events.some(event => event.type === 'audio.delta' && event.responseId === announcement.responseId), false)
    assert.equal(f.client.ready, true, 'speech failure does not disconnect the conversation or discard the result')
  } finally { await f.close() }
})
}
