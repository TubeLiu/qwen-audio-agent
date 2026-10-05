import { randomBytes, randomUUID } from 'node:crypto';
import { validateTool, compileTool, ValidationError } from './tools.mjs';
import { PlanStore } from './plans.mjs';
import { publicConfiguration, redact } from './config.mjs';
import { documentCompletion, documentReference, rememberDocument, rememberSearchDocuments, verifiedDocumentWrite } from './documents.mjs';

const writeIntent = /发送|发给|发一条|发消息|发个消息|发条消息|通知|创建|新建|建立|写入|写上|写进|写.{0,12}(?:云文档|文档)|追加|添加|新增|增加|安排|预约|删除|取消日程|修改|更新|改成|改为|完成.{0,12}任务|标记.{0,8}完成|\b(send|create|append|add|schedule|delete|remove|update|change|complete)\b/i;
const readIntent = /^(?:(?:请|帮我|麻烦|我想|我需要|先|再|接着|现在|就|please|can you|could you)\s*)*(?:查看|查询|读取|搜索|查找|打开|看看|读一下|查一下|\b(?:read|list|show|search|find)\b)/i;
const idKeys = new Set(['chatId', 'userId', 'eventId', 'calendarId', 'baseToken', 'tableId', 'taskId', 'tasklistId', 'assignee']);
const externalIdKeys = new Set(['chat_id', 'open_id', 'user_id', 'event_id', 'calendar_id', 'base_token', 'app_token', 'table_id', 'task_id', 'task_guid', 'guid']);

function collectIds(value, result, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 10) return;
  for (const [key, child] of Object.entries(value)) {
    if (externalIdKeys.has(key) && typeof child === 'string' && child.length < 200) result.add(child);
    if (typeof child === 'object') collectIds(child, result, depth + 1);
  }
}

function validateModelPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new ValidationError('模型计划必须是 JSON 对象。');
  if (plan.kind === 'clarification') {
    if (typeof plan.question !== 'string' || !plan.question.trim() || plan.question.length > 1000) throw new ValidationError('模型没有说明需要补充的信息。');
    return plan;
  }
  if (!['read', 'write'].includes(plan.kind) || !Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > 4) throw new ValidationError('模型计划种类或操作数量不合适。');
  const steps = plan.steps.map(step => {
    if (!step || typeof step !== 'object' || Object.keys(step).some(k => !['tool', 'args'].includes(k))) throw new ValidationError('模型返回了不支持的操作参数。');
    return validateTool(step.tool, step.args);
  });
  if (steps.some(s => s.write !== (plan.kind === 'write'))) throw new ValidationError('查询和写入需要分开执行，请先完成查询。');
  return { kind: plan.kind, steps };
}

function safeData(value, config, depth = 0) {
  if (depth > 12) return '[内容层级过深]';
  if (typeof value === 'string') return redact(config, value);
  if (Array.isArray(value)) return value.slice(0, 200).map(v => safeData(v, config, depth + 1));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, child] of Object.entries(value)) if (!/^(access_token|refresh_token|app_secret|api_key|device_code|tenant_access_token|user_access_token)$/i.test(key)) output[key] = safeData(child, config, depth + 1);
    return output;
  }
  return value;
}

export class Assistant {
  constructor(config, { ai, cli, plans = new PlanStore({ ttlMs: config.planTtlMs }) } = {}) {
    this.config = config; this.ai = ai; this.cli = cli; this.plans = plans; this.sessions = new Map();
  }
  session(id = randomUUID()) {
    let session = this.sessions.get(id);
    if (!session) {
      if (this.sessions.size >= 1000) {
        for (const [key, value] of this.sessions) if (Date.now() - value.lastUsed > 3600000) this.sessions.delete(key);
        if (this.sessions.size >= 1000) throw new Error('会话过多，请稍后重试。');
      }
      session = { id, csrf: randomBytes(32).toString('hex'), history: [], userTexts: [], contextData: [], knownIds: new Set(), knownDocs: new Map(), lastUsed: Date.now(), busy: false, pendingPlan: null, activeWriteIntent: null };
      this.sessions.set(id, session);
    }
    session.lastUsed = Date.now();
    return session;
  }
  async status(session) {
    const auth = await this.cli.authStatus();
    return { ...publicConfiguration(this.config), auth: { installed: auth.installed, available: auth.available, ready: auth.available, verified: auth.verified || false, status: auth.available ? 'ready' : auth.status, appConfigured: auth.appConfigured || false }, sessionId: session.id, csrfToken: session.csrf };
  }
  remember(session, text, response) {
    session.history.push({ role: 'user', content: text }, { role: 'assistant', content: response.text });
    session.history = session.history.slice(-12);
    session.userTexts.push(text); session.userTexts = session.userTexts.slice(-12);
    return { ...response, sessionId: session.id };
  }
  async command(text, session) {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) return { status: 'clarification', text: '请提供 1 至 4000 字的指令。', sessionId: session.id };
    if (session.busy) return { status: 'error', text: '上一条指令仍在处理中，请稍等。', sessionId: session.id };
    session.busy = true;
    try {
      const asksWrite = !readIntent.test(text) && writeIntent.test(text);
      if (/^\s*(取消|取消操作|取消这次操作|算了|不用了|停止|不要执行|不创建了|不要创建了|不发了)\s*[。.!！]?\s*$/i.test(text)) {
        if (session.pendingPlan) { try { this.plans.cancel(session.pendingPlan, session.id); } catch {} }
        session.pendingPlan = null; session.activeWriteIntent = null;
        return this.remember(session, text, { status: 'done', text: '已取消当前请求；没有执行新的飞书操作。' });
      }
      if (asksWrite) session.activeWriteIntent = text;
      else if (readIntent.test(text)) session.activeWriteIntent = null;
      const confirmingText = /^\s*(确认|好的|确定|执行|yes|confirm)\s*[。.!！]?\s*$/i.test(text);
      if (session.pendingPlan && !confirmingText) {
        try { this.plans.cancel(session.pendingPlan, session.id); } catch {}
        session.pendingPlan = null;
      }
      if (this.config.demo) {
        if (session.activeWriteIntent) {
          const plan = this.plans.create(session.id, [], { demo: true }); session.pendingPlan = plan.id;
          return this.remember(session, text, { status: 'confirmation', text: '演示模式：这是确认流程示例，确认后不会写入飞书。', planId: plan.id, preview: `演示指令：${text}\n未连接飞书，不会真实执行。`, demo: true });
        }
        return this.remember(session, text, { status: 'done', text: '演示模式：查询流程已展示。这里没有真实飞书数据；请关闭 DEMO_MODE 并完成 AI 配置与飞书授权。', demo: true });
      }
      if (!this.config.apiKey || !this.config.chatModel) return this.remember(session, text, { status: 'clarification', text: 'AI 尚未配置。请在设置中填写兼容 OpenAI 的接口地址、密钥和对话模型；语音还需要语音识别模型。' });
      if (confirmingText && session.pendingPlan) {
        const plan = this.plans.get(session.pendingPlan, session.id);
        return this.remember(session, text, { status: 'confirmation', text: '请点击确认按钮，或在设备上按 OK 确认下面的操作。', planId: plan.id, preview: plan.steps.map(s => s.preview).join('\n\n') });
      }
      const modelPlan = validateModelPlan(await this.ai.plan(text, session));
      if (modelPlan.kind === 'clarification') return this.remember(session, text, { status: 'clarification', text: modelPlan.question });
      const auth = await this.cli.authStatus();
      if (!auth.available) return this.remember(session, text, { status: 'clarification', text: auth.installed ? '飞书用户身份尚未授权或授权已过期，请先完成飞书授权。' : '尚未安装飞书 CLI，请先运行环境安装脚本。' });
      if (modelPlan.kind === 'write') {
        if (!session.activeWriteIntent) throw new ValidationError('当前指令未明确要求写入。请直接说明要发送、创建、修改、删除或完成哪项内容。');
        const userSource = [...session.userTexts, text].join('\n');
        for (const step of modelPlan.steps) {
          if (step.tool === 'docs.append') {
            const target = documentReference(step.args.doc);
            if (!userSource.includes(step.args.doc) && !session.knownDocs.has(target.value) && !session.knownDocs.has(target.token)) throw new ValidationError('请提供或从文档搜索结果中明确选择真实目标文档，不能使用未经核实的链接或 token。');
          }
          for (const [key, value] of Object.entries(step.args)) {
            if (idKeys.has(key) && typeof value === 'string' && !userSource.includes(value) && !session.knownIds.has(value)) throw new ValidationError(`请提供或从已查询结果中明确选择 ${key}，不能使用未经核实的目标。`);
            if (key === 'attendeeIds' && value.some(id => !userSource.includes(id) && !session.knownIds.has(id))) throw new ValidationError('请提供参与人的真实飞书 ID。');
          }
        }
        if (session.pendingPlan) { try { this.plans.cancel(session.pendingPlan, session.id); } catch {} }
        const plan = this.plans.create(session.id, modelPlan.steps); session.pendingPlan = plan.id;
        return this.remember(session, text, { status: 'confirmation', text: '请核对目标、内容和时间，确认后执行。', planId: plan.id, preview: modelPlan.steps.map((s, i) => `${i + 1}. ${s.preview}`).join('\n\n') });
      }
      const data = [];
      for (const step of modelPlan.steps) {
        const result = safeData(await this.cli.execute(compileTool(step, { openId: auth.openId })), this.config);
        data.push({ tool: step.tool, data: result });
        // A document body never grants a capability to send to an ID it contains.
        if (['chats.search', 'calendar.list', 'base.records.list', 'tasks.list'].includes(step.tool)) collectIds(result, session.knownIds);
        if (step.tool === 'docs.search') rememberSearchDocuments(session, result);
      }
      session.contextData = data;
      let answer;
      try { answer = await this.ai.summarize(text, data); } catch { answer = '查询已完成，AI 摘要暂不可用。请查看返回的飞书结果。'; }
      return this.remember(session, text, { status: 'done', text: redact(this.config, answer), data });
    } catch (error) {
      return this.remember(session, text, { status: error instanceof ValidationError ? 'clarification' : 'error', text: redact(this.config, error.message), ...(error.details?.missingScopes?.length ? { missingScopes: error.details.missingScopes } : {}) });
    } finally { session.busy = false; }
  }
  async confirm(planId, session) {
    const result = await this.plans.consume(planId, session.id, async plan => {
      if (plan.demo) return { status: 'done', text: '演示确认完成。没有向飞书发送、创建或修改任何内容。', demo: true };
      const auth = await this.cli.authStatus({ fresh: true });
      if (!auth.available) return { status: 'error', text: '飞书授权不可用；本次计划已结束，请授权后重新下达指令。', completed: [], failedStep: 1 };
      const completed = [];
      const documentResults = [];
      for (let index = 0; index < plan.steps.length; index++) {
        const step = plan.steps[index];
        try {
          const data = verifiedDocumentWrite(step, safeData(await this.cli.execute(compileTool(step, { openId: auth.openId })), this.config), session.knownDocs);
          completed.push({ tool: step.tool, data }); collectIds(data, session.knownIds);
          const documentResult = documentCompletion(step, data);
          if (documentResult) {
            documentResults.push(documentResult);
            rememberDocument(session, documentReference(data.documentUrl || step.args.doc));
          }
        } catch (error) {
          const text = `${completed.length ? `前 ${completed.length} 项已成功；` : ''}第 ${index + 1} 项未取得成功结果：${redact(this.config, error.message)} 后续步骤未执行。此计划不会重试写入；请先在飞书核对状态，再发起新指令。`;
          return { status: 'error', text, completed, failedStep: index + 1, ...(error.details?.missingScopes?.length ? { missingScopes: error.details.missingScopes } : {}) };
        }
      }
      return { status: 'done', text: `已完成 ${completed.length} 项飞书操作。${documentResults.length ? '\n' + documentResults.join('\n') : ''}`, data: completed };
    });
    if (session.pendingPlan === planId) session.pendingPlan = null;
    session.activeWriteIntent = null;
    const plan = this.plans.get(planId, session.id);
    if (!plan.remembered) {
      plan.remembered = true;
      session.history.push({ role: 'assistant', content: result.text }); session.history = session.history.slice(-12);
      if (result.data || result.completed) session.contextData = result.data || result.completed;
    }
    return { ...result, sessionId: session.id };
  }
  cancel(planId, session) {
    const result = this.plans.cancel(planId, session.id);
    if (session.pendingPlan === planId) session.pendingPlan = null;
    session.activeWriteIntent = null;
    return { ...result, sessionId: session.id };
  }
  reset(session) {
    if (session.busy || [...this.plans.plans.values()].some(plan => plan.sessionId === session.id && plan.state === 'running')) throw new Error('当前指令仍在处理中，请稍后清空。');
    for (const plan of this.plans.plans.values()) if (plan.sessionId === session.id && plan.state === 'pending') this.plans.cancel(plan.id, session.id);
    session.history = []; session.userTexts = []; session.contextData = []; session.knownIds.clear(); session.knownDocs.clear(); session.pendingPlan = null; session.activeWriteIntent = null;
    return { status: 'done', text: '当前会话已清空，待确认计划已取消。', sessionId: session.id };
  }
}
