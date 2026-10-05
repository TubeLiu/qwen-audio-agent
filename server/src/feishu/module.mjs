import { createFeishuAuthService } from './auth-service.mjs'
import { FeishuWorkService } from './work-service.mjs'
import { FeishuFrontendToolSource } from './frontend-source.mjs'
import { feishuConfiguration, publicConfiguration, redact } from './config.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

export function createFeishuModule({ config, taskManager, taskOperations, work: injectedWork, authService: injectedAuth, ...dependencies } = {}) {
  const settings = feishuConfiguration(config, dependencies)
  const work = injectedWork || new FeishuWorkService(settings, dependencies)
  const auth = injectedAuth || createFeishuAuthService({ config })
  const source = new FeishuFrontendToolSource({ work, taskManager, enabled: settings.enabled })
  const unregister = taskOperations.registerInputResponder('feishu', (taskId, inputId, response, options) => work.respondInput(taskId, inputId, response, options))
  const owner = req => ({ ownerId: req.identity.ownerId })
  const route = handler => async (req, res) => {
    try { if (!settings.enabled) return res.status(404).json({ error: '飞书功能未启用。' }); await handler(req, res) }
    catch (error) { res.status(400).json({ error: redact(settings, error.message), code: error.code || 'feishu_error' }) }
  }
  const localOnly = (req, res) => {
    if (req.identity.access === 'local') return true
    res.status(403).json({ error: '飞书本机授权只能在本机设置中修改。' }); return false
  }
  return {
    services: { feishu: { work, auth, source } }, frontendToolSources: [source],
    sessionObservers: [{ onUserInput: value => work.recordUserText(value) }],
    async close() { unregister(); await work.close(); await auth.close?.() },
    mountRoutes(app) {
      app.get('/api/feishu/status', route(async (_req, res) => res.json({ ...publicConfiguration(settings), auth: await auth.status() })))
      app.post('/api/feishu/auth/login', route(async (req, res) => { if (localOnly(req, res)) res.json(await auth.login(req.identity.ownerId)) }))
      app.post('/api/feishu/auth/complete', route(async (req, res) => { if (localOnly(req, res)) res.json({ auth: await auth.complete(req.body?.attemptId, req.identity.ownerId) }) }))
      app.get('/api/feishu/plans/:id', route(async (req, res) => {
        if (!UUID.test(req.params.id)) throw new Error('确认计划标识无效。')
        res.setHeader('Cache-Control', 'no-store'); res.json(work.getPreview(req.params.id, owner(req)))
      }))
      app.post('/api/feishu/plans/:id/confirm', route(async (req, res) => {
        if (!UUID.test(req.params.id) || req.body?.reviewed !== true) throw new Error('请先阅读完整预览并勾选阅读确认，再点击本次执行按钮。')
        const preview = work.getPreview(req.params.id, owner(req))
        if (req.body.reviewToken !== preview.reviewToken) throw new Error('请重新打开本次完整预览后点击确认。')
        // This route is absent from every model/MCP tool catalog. General
        // respond_permission/respond_agent_input can never consume this plan.
        res.json(await work.confirmFromUi(req.params.id, { ...owner(req), taskId: req.body.taskId }))
      }))
      app.post('/api/feishu/plans/:id/cancel', route(async (req, res) => {
        const preview = work.getPreview(req.params.id, owner(req))
        const result = await taskManager.cancel(preview.taskId, owner(req)); res.json({ status: 'done', task: result })
      }))
      app.get('/api/feishu/events', route(async (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders()
        const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`)
        for (const preview of work.pending(owner(req))) send({ type: 'feishu.preview', ...preview })
        const unsubscribe = work.subscribePreviews(event => {
          const preview = work.previews.get(event.planId)
          if (preview?.ownerId === req.identity.ownerId) send(event)
        })
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000); heartbeat.unref?.()
        res.on('close', () => { clearInterval(heartbeat); unsubscribe() })
      }))
    },
  }
}
