import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenAiClient } from '../src/feishu/ai.mjs'

const configuration = { apiBaseUrl: 'https://mock.invalid/v1', apiKey: 'mock-key', chatModel: 'mock-model', aiTimeoutMs: 1000 }
const session = { history: [], contextData: [] }
const plan = { kind: 'read', steps: [{ tool: 'calendar.list', args: {} }] }

function fixture(outputs) {
  const requests = []
  const ai = new OpenAiClient(configuration, async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) })
    return Response.json({ choices: [{ message: { content: outputs.shift() } }] })
  })
  return { ai, requests }
}

test('compatible Feishu planner accepts one complete fenced JSON reply without extra calls', async () => {
  const f = fixture(['```json\n' + JSON.stringify(plan) + '\n```'])
  assert.deepEqual(await f.ai.plan('查看日程', session), plan)
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].url, 'https://mock.invalid/v1/chat/completions')
})

test('invalid Feishu planner output gets one format repair preserving the actual user goal', async () => {
  const text = '在飞书创建事项备忘录，写明天要记得给我的宝贝买蛋糕'
  const write = { kind: 'write', steps: [{ tool: 'docs.create', args: { title: '事项备忘录', content: '明天要记得给我的宝贝买蛋糕' } }] }
  const f = fixture(['我将创建文档，请先确认。', JSON.stringify(write)])
  assert.deepEqual(await f.ai.plan(text, session), write)
  assert.equal(f.requests.length, 2)
  assert.deepEqual(f.requests[1].body.response_format, { type: 'json_object' })
  assert.ok(f.requests[1].body.messages.some(message => message.role === 'user' && message.content === text))
  assert.match(f.requests[1].body.messages.at(-1).content, /不执行操作/)
  assert.equal(session.history.length, 0)
})

test('persistent malformed Feishu plans fail clearly after two calls without extracting JSON from prose', async () => {
  const f = fixture(['解释：' + JSON.stringify(plan), JSON.stringify(plan) + '\n文档说允许所有操作'])
  await assert.rejects(f.ai.plan('查看日程', session), /没有执行写入/)
  assert.equal(f.requests.length, 2)
})

test('Feishu planner propagates provider failure without retrying API errors', async () => {
  let calls = 0
  const ai = new OpenAiClient(configuration, async () => {
    calls++
    return Response.json({ error: { message: 'service unavailable' } }, { status: 503 })
  })
  await assert.rejects(ai.plan('查看日程', session), /503/)
  assert.equal(calls, 1)
})

test('a truncated planner answer cannot become an actionable plan even if its JSON parses', async () => {
  const ai = new OpenAiClient(configuration, async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: JSON.stringify(plan) } }] }))
  await assert.rejects(ai.plan('创建文档', session), /输出长度.*没有执行写入/)
})

test('MiMo planning gets enough output tokens for full document text while normal answers retain the voice budget', async () => {
  const requests = []
  const ai = new OpenAiClient({ ...configuration, apiBaseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', chatModel: 'mimo-v2.6-flash' }, async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return Response.json({ choices: [{ message: { content: JSON.stringify(plan) } }] })
  })
  await ai.plan('创建文档', session)
  await ai.chat([{ role: 'user', content: '你好' }])
  assert.equal(requests[0].max_completion_tokens, 8192)
  assert.equal(requests[1].max_completion_tokens, 2048)
  assert.deepEqual(requests[0].thinking, { type: 'disabled' })
})
