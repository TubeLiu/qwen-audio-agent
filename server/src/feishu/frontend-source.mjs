import { randomUUID } from 'node:crypto'

const TOOL = 'feishu_submit'

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
        description: '飞书专用工作：读取/搜索文档、群聊、任务与日程，发送消息，创建或更新日程、任务和多维表格。立即返回真实任务编号，进度和最终结果由任务系统播报。飞书工作必须用此工具，不要交给通用后台、shell或其他MCP绕过确认。所有飞书写入均等待用户阅读完整预览后点击按钮；口头确认、记忆、允许此任务与始终允许均无效。参数只是工作目标，执行以当前真实用户指令为准。',
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
    return { status: task.reused ? 'existing' : 'accepted', taskId: task.id, objective: task.objective,
      message: '飞书工作已进入任务队列。写操作尚未执行；如需写入，将提供逐次完整预览。', receiptId: randomUUID() }
  }
}
