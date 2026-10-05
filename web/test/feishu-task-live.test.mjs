import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { GatewayClient } from '../../shared/gateway/client-sdk.mjs'
import { setRuntimeLanguage } from '../src/i18n.js'
import {
  removeDeliveredTask,
  taskDetail,
  taskInteractionActivity,
  taskLabel,
  taskNeedsFeishuConfirmation,
  taskNeedsPresentation,
  taskView,
  upsertTaskView,
} from '../src/task-view.js'

let server
let FeishuConfirmation
let PermissionActions

before(async () => {
  setRuntimeLanguage('zh-CN')
  server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: false,
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false },
  })
  FeishuConfirmation = (await server.ssrLoadModule('/src/FeishuConfirmation.jsx')).default
  PermissionActions = (await server.ssrLoadModule('/src/PermissionActions.jsx')).default
})

after(async () => { await server?.close() })

class Socket {
  readyState = 0
  listeners = new Map()
  sent = []
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener])
  }
  emit(type, value = {}) {
    for (const listener of this.listeners.get(type) || []) listener(value)
  }
  open() { this.readyState = 1; this.emit('open') }
  send(raw) { this.sent.push(JSON.parse(raw)) }
  close() { this.readyState = 3 }
  receive(value) { this.emit('message', { data: JSON.stringify(value) }) }
}

function task(overrides = {}) {
  return {
    id: 'feishu-task', kind: 'feishu', status: 'running', workState: 'working',
    objective: '处理飞书请求', createdAt: 1, elapsedMs: 0,
    inputRequest: null, authorization: null, ...overrides,
  }
}

function input(kind, prompt, id = 'preview-plan') {
  return {
    id, taskId: 'feishu-task', status: 'pending', kind, mode: 'text',
    prompt, createdAt: 2, resolvedAt: null,
  }
}

function connect(context, initialTasks = []) {
  const socket = new Socket()
  let tasks = initialTasks.map(item => taskView(item))
  let activity = ''
  const events = []
  const client = new GatewayClient({
    url: 'ws://gateway.test/api/realtime', createSocket: () => socket,
    clientType: 'web', clientInstanceId: 'feishu-live-test',
    capabilities: [], reconnect: false,
    onEvent(event) {
      events.push(event.type)
      const nextActivity = taskInteractionActivity(event)
      if (nextActivity) {
        activity = nextActivity
        tasks = upsertTaskView(tasks, event.task)
      } else if (event.type === 'task.completed') {
        tasks = upsertTaskView(tasks, event.task)
      } else if (event.type === 'task.notification.delivered') {
        tasks = removeDeliveredTask(tasks, event.task.id)
      }
    },
  }).start()
  context.after(() => client.stop())
  socket.open()
  socket.receive({
    type: 'session.ready', event_id: 'ready',
    request_event_id: socket.sent[0].event_id, protocol_version: '7.0.0',
    session_id: 'main', capabilities: [],
  })
  return {
    receive(type, sequence, value) {
      socket.receive({ type, event_id: `event-${sequence}`, sequence, task: value })
    },
    get tasks() { return tasks },
    get activity() { return activity },
    events,
  }
}

function cardMarkup(task) {
  return renderToStaticMarkup(createElement('aside', null,
    createElement('b', null, taskLabel(task)),
    createElement('small', null, taskDetail(task)),
    task.authorization?.status === 'pending'
      ? createElement(PermissionActions, { authorization: task.authorization, onRespond() {} })
      : null,
    taskNeedsFeishuConfirmation(task) ? createElement(FeishuConfirmation, { task }) : null,
  ))
}

test('live input events mount and clear the Feishu confirmation without task.updated or refresh', context => {
  const live = connect(context, [task({ status: 'queued', workState: 'submitted' })])
  const pending = task({
    workState: 'auth_required',
    inputRequest: input('authorization', '在本应用核对完整预览，再点击本次确认。'),
  })
  live.receive('task.input.requested', 1, pending)
  assert.equal(live.tasks.length, 1)
  assert.equal(live.activity, '等待你的确认')
  assert.equal(taskNeedsFeishuConfirmation(live.tasks[0]), true)
  assert.match(cardMarkup(live.tasks[0]), /飞书本次操作确认/u)
  assert.match(cardMarkup(live.tasks[0]), /在本应用核对完整预览/u)

  live.receive('task.input.resolved', 2, task())
  assert.equal(live.tasks[0].inputRequest, null)
  assert.equal(live.activity, '正在继续处理')
  assert.equal(taskNeedsFeishuConfirmation(live.tasks[0]), false)
  assert.doesNotMatch(cardMarkup(live.tasks[0]), /飞书本次操作确认|核对完整预览/u)
  // A replayed older pending event cannot resurrect a consumed preview.
  live.receive('task.input.requested', 1, pending)
  assert.equal(live.tasks[0].inputRequest, null)
  assert.deepEqual(live.events, ['task.input.requested', 'task.input.resolved'])
})

test('a live clarification adds a missing task, presents its full prompt, and disappears when resolved', context => {
  const live = connect(context)
  const pending = task({
    workState: 'input_required',
    inputRequest: input('input', '要查询哪份飞书文档？请提供文档链接或完整标题。'),
  })
  live.receive('task.input.requested', 1, pending)
  assert.equal(taskNeedsPresentation(pending), true)
  assert.equal(live.activity, '等待补充信息')
  assert.equal(taskLabel(live.tasks[0]), '等待补充信息')
  assert.match(cardMarkup(live.tasks[0]), /要查询哪份飞书文档？请提供文档链接或完整标题。/u)
  assert.equal(taskNeedsFeishuConfirmation(live.tasks[0]), false)

  live.receive('task.input.resolved', 2, task())
  assert.doesNotMatch(cardMarkup(live.tasks[0]), /要查询哪份飞书文档|等待补充信息/u)
  assert.deepEqual(live.events, ['task.input.requested', 'task.input.resolved'])
})

test('input events preserve an independent pending backend permission and permission resolution', context => {
  const authorization = {
    id: 'backend-permission', taskId: 'backend-task', status: 'pending',
    summary: '允许读取本地工作目录', createdAt: 1, resolvedAt: null,
  }
  const backendTask = task({ id: 'backend-task', kind: 'work', authorization })
  const live = connect(context)
  live.receive('task.permission.requested', 1, backendTask)
  live.receive('task.input.requested', 2, task({
    workState: 'auth_required', inputRequest: input('authorization', '确认飞书消息收件人和正文。'),
  }))
  assert.equal(live.tasks.length, 2)
  assert.deepEqual(live.tasks[0].authorization, authorization)
  assert.match(cardMarkup(live.tasks[0]), /role="group"/u)
  assert.equal(taskNeedsFeishuConfirmation(live.tasks[0]), false)
  assert.equal(taskNeedsFeishuConfirmation(live.tasks[1]), true)

  live.receive('task.input.resolved', 3, task())
  assert.match(cardMarkup(live.tasks[0]), /role="group"/u)
  live.receive('task.permission.resolved', 4, { ...backendTask, authorization: null })
  assert.equal(live.tasks[0].authorization, null)
  assert.doesNotMatch(cardMarkup(live.tasks[0]), /role="group"/u)
})

test('a Feishu read result arrives live without confirmation and settles after playback delivery', context => {
  const live = connect(context, [task()])
  live.receive('task.completed', 1, task({
    status: 'completed', workState: 'completed', notificationStatus: 'pending',
    result: '这份文档的负责人是小李，截止日期为周五。',
  }))
  assert.equal(live.tasks[0].phase, 'responding')
  assert.equal(live.tasks[0].result, '这份文档的负责人是小李，截止日期为周五。')
  assert.equal(taskNeedsFeishuConfirmation(live.tasks[0]), false)
  live.receive('task.notification.delivered', 2, task({
    status: 'completed', workState: 'completed', notificationStatus: 'delivered',
  }))
  assert.deepEqual(live.tasks, [])
})
