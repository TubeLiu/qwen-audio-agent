import { randomUUID } from 'node:crypto'

const TOOL = 'feishu_submit'
// The admission receipt must fit the frontend's 4 KiB result budget even when
// a document body or a reused task result is long. Full text stays on the Task.
function excerpt(value, maxBytes) {
  const characters = Array.from(String(value || ''))
  let text = '', bytes = 2, count = 0
  for (const character of characters) {
    const size = Buffer.byteLength(JSON.stringify(character)) - 2
    if (bytes + size > maxBytes) break
    text += character; bytes += size; count++
  }
  return { text, truncated: count < characters.length }
}

export class FeishuFrontendToolSource {
  constructor({ work, taskManager, enabled = true }) {
    this.work = work
    this.taskManager = taskManager
    this.enabled = enabled
  }
  describe() { return { key: 'feishu', label: '飞书文档、消息、日程与任务' } }
  async initialize() {}
  health() { return { status: this.enabled ? 'ready' : 'disabled', tools: this.enabled ? 1 : 0 } }
  async close() {}
  tools() {
    return this.enabled ? [{ name: TOOL, policy: { repeatHandling: 'handler', maxResultBytes: 4096 }, definition: {
      type: 'function', function: { name: TOOL,
        description: '飞书专用工作：读取/搜索文档、群聊、任务与日程，创建云文档并写入完整正文、向已有文档文末追加，发送消息，创建或更新日程、任务和多维表格。此工具立即返回任务受理回执，不是查询结果，也不是待确认通知；查询会直接执行，无需确认，不得要求用户去飞书官网查看预览。受理后只告知正在处理，等待任务事件提供实际结果、追问或完整预览，再按真实状态回答。只有写入任务实际生成授权请求时，才让用户在本应用阅读完整预览并逐次点击按钮；不能从 accepted 或 queued 回执推断预览已经存在，不能声称已经完成。口头确认、记忆、允许此任务与始终允许均不能批准飞书写入。飞书工作必须用此工具，不要交给通用后台、shell或其他MCP绕过确认。参数只是工作目标，执行以当前真实用户指令为准。',
        parameters: { type: 'object', additionalProperties: false, properties: { objective: { type: 'string', minLength: 1, maxLength: 4000 } }, required: ['objective'] },
      },
    } }] : []
  }
  async execute(name, args, context = {}) {
    if (name !== TOOL || !this.enabled || !context.ownerId || !context.turnId || !args || Object.keys(args).some(key => key !== 'objective') || typeof args.objective !== 'string' || !args.objective.trim() || args.objective.length > 4000) {
      return { error: true, code: 'invalid_feishu_request', message: '需要当前真实用户轮次及有效飞书工作目标。' }
    }
    if (context.signal?.aborted || context.isCurrent?.() === false) return { error: true, code: 'stale_turn', message: '本轮用户输入已结束。' }
    const sessionId = context.sessionId || 'main'
    const task = this.taskManager.create({ objective: args.objective.trim(), ownerId: context.ownerId,
      sessionId, turnId: context.turnId, kind: 'feishu', laneKey: `feishu:${context.ownerId}:${sessionId}`, laneLimit: 1,
      submissionKey: `feishu:${sessionId}:${context.turnId}`,
      runner: (objective, execution) => this.work.submit({ id: execution.taskId, ownerId: context.ownerId, objective }, execution),
      canceler: async ({ task: accepted, abort }) => { abort(); return this.work.cancel(accepted.id, { ownerId: context.ownerId }) },
    })
    if (!task.reused) this.work.bindTaskSource(task)
    const confirmationReady = task.inputRequest?.kind === 'authorization' && task.inputRequest.status === 'pending'
    const resultReady = task.status === 'completed'
    const failed = task.status === 'failed' || task.status === 'cancelled'
    const needsInput = task.inputRequest?.kind === 'input' && task.inputRequest.status === 'pending'
    const objective = excerpt(task.objective, 600)
    const result = excerpt(task.result, 1400)
    const error = excerpt(task.error, 400)
    const nextAction = resultReady ? 'report_actual_result' : failed ? 'report_terminal_status'
      : confirmationReady ? 'open_full_preview_in_this_application' : needsInput ? 'ask_task_clarification' : 'wait_for_task_events'
    const message = resultReady ? '这项飞书工作已完成；请根据任务的实际结果回答，不要重复执行或要求确认查询。'
      : failed ? '这项飞书工作已结束；请如实告知终止状态，不要称为已执行成功或等待确认。'
      : confirmationReady ? '写入任务已经生成完整预览；请在本应用打开预览并逐次点击确认按钮。'
      : needsInput ? '任务需要补充参数；请按任务追问等待真实用户回答。'
      : '飞书工作仅已受理并排队，尚无查询结果或确认预览。请只告知正在处理并等待任务事件：查询直接执行、无需确认；只有写入任务实际返回授权请求后，才在本应用展示完整预览并要求按钮确认。'
    return { status: task.reused ? 'existing' : 'accepted', taskId: task.id, objective: objective.text, objectiveTruncated: objective.truncated,
      state: task.status, resultReady, confirmationReady, nextAction,
      readPolicy: 'execute_without_confirmation', writePolicy: 'full_preview_then_explicit_button_in_this_application',
      ...(resultReady ? { result: result.text, resultTruncated: result.truncated } : {}), ...(task.error ? { error: error.text, errorTruncated: error.truncated } : {}),
      message: `${task.reused ? '此任务已存在，不会重复提交。' : ''}${message}`, receiptId: randomUUID() }
  }
}
