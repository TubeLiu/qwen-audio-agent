import { randomUUID } from 'node:crypto';

export class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}

const string = (max = 2000, pattern) => ({ type: 'string', maxLength: max, ...(pattern ? { pattern } : {}) });
const idSchema = string(200, '^[A-Za-z0-9][A-Za-z0-9_.@=:-]*$');
const dateSchema = string(35);
const taskFields = [{ name: '标题', type: 'text' }, { name: '状态', type: 'select', multiple: false, options: [{ name: '待办' }, { name: '完成' }] }];
const args = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required });
const definition = (description, write, schema, build, preview) => ({ description, write, schema, build, preview });
const optional = (argv, name, value) => { if (value !== undefined && value !== '') argv.push(name, String(value)); };
const user = argv => [...argv, '--as', 'user'];

export const TOOLS = {
  'docs.read': definition('读取一个飞书文档或知识库。必须提供用户给出的 URL/token，不能猜测。', false, args({ doc: string(2048) }, ['doc']), a => user(['docs', '+fetch', '--doc', a.doc, '--doc-format', 'markdown']), a => `读取文档：${a.doc}`),
  'docs.search': definition('按关键词搜索用户可访问的文档/知识库。query最多30字。', false, args({ query: string(30), pageToken: string(1000) }, ['query']), a => { const v = ['drive', '+search', '--query', a.query, '--doc-types', 'docx,wiki', '--page-size', '15']; optional(v, '--page-token', a.pageToken); return user(v); }, a => `搜索文档：${a.query}`),
  'chats.search': definition('按群名称查找飞书群，结果提供可发消息的 chat_id。', false, args({ query: string(100) }, ['query']), a => user(['im', '+chat-search', '--query', a.query, '--page-size', '20']), a => `查找群聊：${a.query}`),
  'messages.send': definition('向用户明确指定的群或个人发送文本。chatId和userId必须且只能给一个，必须来自用户输入或已确认的搜索结果；无法定位收件人时先查询或提问。', true, args({ chatId: string(100, '^oc_[A-Za-z0-9]+$'), userId: string(100, '^ou_[A-Za-z0-9]+$'), text: string(6000) }, ['text']), (a, context) => user(['im', '+messages-send', a.chatId ? '--chat-id' : '--user-id', a.chatId || a.userId, '--msg-type', 'text', '--content', JSON.stringify({ text: a.text }), '--idempotency-key', context.idempotencyKey]), a => `发送给 ${a.chatId || a.userId}\n${a.text}`),
  'calendar.list': definition('查询日程。start/end可为YYYY-MM-DD或带时区的RFC3339，必须有明确查询范围。', false, args({ start: dateSchema, end: dateSchema }, ['start', 'end']), a => user(['calendar', '+agenda', '--start', a.start, '--end', a.end]), a => `查看日程：${a.start} 至 ${a.end}`),
  'calendar.create': definition('创建飞书日程，start和end必须是带明确时区的RFC3339。未提供日期/时间/时长必须提问，不要默认一小时。', true, args({ summary: string(300), start: dateSchema, end: dateSchema, description: string(4000), calendarId: idSchema, attendeeIds: { type: 'array', maxItems: 30, items: string(100, '^(ou_|oc_|omm_)[A-Za-z0-9]+$') } }, ['summary', 'start', 'end']), a => { const v = ['calendar', '+create', '--summary', a.summary, '--start', a.start, '--end', a.end]; optional(v, '--description', a.description); optional(v, '--calendar-id', a.calendarId); if (a.attendeeIds?.length) optional(v, '--attendee-ids', a.attendeeIds.join(',')); return user(v); }, a => `创建日程：${a.summary}\n${a.start} 至 ${a.end}${a.attendeeIds?.length ? `\n参与人：${a.attendeeIds.join(', ')}` : ''}${a.description ? `\n${a.description}` : ''}`),
  'calendar.update': definition('修改指定eventId日程。更新起止时间必须同时给start/end；重复日程必须明确applyTo single|all|this-and-following。', true, args({ eventId: idSchema, calendarId: idSchema, summary: string(300), description: string(4000), start: dateSchema, end: dateSchema, applyTo: { type: 'string', enum: ['single', 'all', 'this-and-following'] } }, ['eventId']), a => { const v = ['calendar', '+update', '--event-id', a.eventId]; for (const [k, f] of [['calendarId', '--calendar-id'], ['summary', '--summary'], ['description', '--description'], ['start', '--start'], ['end', '--end'], ['applyTo', '--apply-to']]) optional(v, f, a[k]); return user(v); }, a => `修改日程 ${a.eventId}${a.calendarId ? `（日历 ${a.calendarId}）` : ''}\n${a.summary || ''}${a.start ? `\n${a.start} 至 ${a.end}` : ''}${a.description ? `\n${a.description}` : ''}${a.applyTo ? `\n重复范围：${a.applyTo}` : ''}`),
  'calendar.delete': definition('删除指定eventId日程。重复日程必须明确applyTo single|all|this-and-following。此操作不可撤回，必须预览确认。', true, args({ eventId: idSchema, calendarId: idSchema, applyTo: { type: 'string', enum: ['single', 'all', 'this-and-following'] } }, ['eventId']), a => { const v = ['calendar', '+delete', '--event-id', a.eventId, '--yes']; optional(v, '--calendar-id', a.calendarId); optional(v, '--apply-to', a.applyTo); return user(v); }, a => `删除日程：${a.eventId}${a.calendarId ? `\n日历：${a.calendarId}` : ''}\n范围：${a.applyTo || '指定日程（如为重复日程将拒绝执行）'}`),
  'base.create': definition('创建一个多维表格，首表固定有标题/状态（待办、完成）两列，适合任务清单。', true, args({ name: string(200), tableName: string(100) }, ['name']), a => user(['base', '+base-create', '--name', a.name, '--time-zone', 'Asia/Shanghai', '--table-name', a.tableName || '任务', '--fields', JSON.stringify(taskFields)]), a => `创建多维表格：${a.name}\n首表：${a.tableName || '任务'}；字段：标题、状态（待办/完成）`),
  'base.table.create': definition('在指定多维表格增加任务表，固定标题/状态两列。', true, args({ baseToken: idSchema, name: string(100) }, ['baseToken', 'name']), a => user(['base', '+table-create', '--base-token', a.baseToken, '--name', a.name, '--fields', JSON.stringify(taskFields)]), a => `增加任务表：${a.name}\n多维表格：${a.baseToken}`),
  'base.records.list': definition('查看指定多维表格任务记录，返回最多100条。', false, args({ baseToken: idSchema, tableId: string(100, '^tbl[A-Za-z0-9]+$'), offset: { type: 'integer', minimum: 0, maximum: 100000 } }, ['baseToken', 'tableId']), a => { const v = ['base', '+record-list', '--base-token', a.baseToken, '--table-id', a.tableId, '--format', 'json', '--limit', '100']; optional(v, '--offset', a.offset); return user(v); }, a => `查看表格任务：${a.baseToken}/${a.tableId}`),
  'base.records.create': definition('在指定任务表添加任务记录；表中需要标题(text)和状态(select)列；可明确传titleField/statusField适配现有字段名。', true, args({ baseToken: idSchema, tableId: string(100, '^tbl[A-Za-z0-9]+$'), titleField: string(100), statusField: string(100), tasks: { type: 'array', minItems: 1, maxItems: 20, items: args({ title: string(1000), status: { type: 'string', enum: ['待办', '完成'] } }, ['title']) } }, ['baseToken', 'tableId', 'tasks']), a => user(['base', '+record-batch-create', '--base-token', a.baseToken, '--table-id', a.tableId, '--json', JSON.stringify({ create_records: a.tasks.map(t => ({ [a.titleField || '标题']: t.title, [a.statusField || '状态']: [t.status || '待办'] })) })]), a => `添加 ${a.tasks.length} 条表格任务\n目标：${a.baseToken}/${a.tableId}\n字段：${a.titleField || '标题'}、${a.statusField || '状态'}\n${a.tasks.map(t => `${t.title}（${t.status || '待办'}）`).join('\n')}`),
  'tasks.list': definition('查询我的飞书任务（单页最多50条），可用关键词及complete过滤。', false, args({ query: string(100), complete: { type: 'boolean' }, pageToken: string(1000) }, []), a => { const v = ['task', '+get-my-tasks']; optional(v, '--query', a.query); if (a.complete !== undefined) v.push(`--complete=${a.complete}`); optional(v, '--page-token', a.pageToken); return user(v); }, a => `查看我的任务${a.query ? `：${a.query}` : ''}`),
  'tasks.create': definition('创建飞书任务；默认由已登录用户负责，可提供明确assignee open_id。due可为YYYY-MM-DD或带时区RFC3339；没有截止时间则不设，不猜测。', true, args({ summary: string(300), description: string(4000), due: dateSchema, assignee: string(100, '^ou_[A-Za-z0-9]+$'), tasklistId: idSchema }, ['summary']), (a, context) => { const v = ['task', '+create', '--summary', a.summary, '--idempotency-key', context.idempotencyKey]; optional(v, '--description', a.description); optional(v, '--due', a.due); optional(v, '--assignee', a.assignee || context.openId); optional(v, '--tasklist-id', a.tasklistId); return user(v); }, a => `创建任务：${a.summary}\n负责人：${a.assignee || '当前登录用户'}${a.due ? `\n截止：${a.due}` : ''}${a.description ? `\n${a.description}` : ''}`),
  'tasks.complete': definition('完成明确taskId任务；必须为GUID，不可使用t123之类显示编号。', true, args({ taskId: string(100, '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$') }, ['taskId']), a => user(['task', '+complete', '--task-id', a.taskId]), a => `完成任务：${a.taskId}`),
};

function validateSchema(schema, value, path) {
  if (schema.type === 'object') {
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new ValidationError(`${path} 必须是对象。`);
    for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) throw new ValidationError(`${path} 包含不支持的参数 ${key}。`);
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new ValidationError(`还需要提供 ${path}.${key}。`);
    for (const [key, item] of Object.entries(value)) validateSchema(schema.properties[key], item, `${path}.${key}`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems || 0) || value.length > (schema.maxItems || 100)) throw new ValidationError(`${path} 数量不合适。`);
    value.forEach((item, index) => validateSchema(schema.items, item, `${path}[${index}]`));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || !value.trim() || value.length > schema.maxLength || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(value) || (schema.pattern && !new RegExp(schema.pattern).test(value))) throw new ValidationError(`${path} 格式不正确或过长。`);
    if (schema.enum && !schema.enum.includes(value)) throw new ValidationError(`${path} 取值不支持。`);
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum) throw new ValidationError(`${path} 必须是范围内的整数。`);
  } else if (typeof value !== schema.type) throw new ValidationError(`${path} 类型不正确。`);
}

function validDate(value, timeRequired = false) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2})))?$/);
  if (!match || (timeRequired && match[4] === undefined)) return false;
  const [, year, month, day, hour, minute, second, zoneHour, zoneMinute] = match;
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()) return false;
  if (Number(hour || 0) > 23 || Number(minute || 0) > 59 || Number(second || 0) > 59 || Number(zoneHour || 0) > 14 || Number(zoneMinute || 0) > 59) return false;
  return Number.isFinite(Date.parse(value));
}

export function validateTool(name, input) {
  const tool = TOOLS[name];
  if (!tool) throw new ValidationError(`不支持操作 ${name}。`);
  const values = structuredClone(input);
  validateSchema(tool.schema, values, name);
  if (name === 'messages.send' && Boolean(values.chatId) === Boolean(values.userId)) throw new ValidationError('需要且只能指定一个收件人：chatId 或 userId。');
  if (name === 'docs.read') {
    if (/^https:\/\//.test(values.doc)) {
      let url;
      try { url = new URL(values.doc); } catch { throw new ValidationError('文档地址不正确。'); }
      if (url.username || url.password || !/(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname) || !/^\/(docx|docs|wiki)\//.test(url.pathname)) throw new ValidationError('请提供飞书 docx/wiki 文档地址。');
    } else if (!/^[A-Za-z0-9]{10,150}$/.test(values.doc)) throw new ValidationError('请提供有效的飞书文档 token 或地址。');
  }
  for (const key of ['start', 'end', 'due']) if (values[key] && !validDate(values[key], name.startsWith('calendar.') && name !== 'calendar.list')) throw new ValidationError(`${key} 日期必须有效；日程写入时间需要明确时区。`);
  if (values.start && values.end && Date.parse(values.start) >= Date.parse(values.end)) throw new ValidationError('结束时间必须晚于开始时间。');
  if (name === 'calendar.update') {
    if (Boolean(values.start) !== Boolean(values.end)) throw new ValidationError('调整时间需要同时提供开始与结束时间。');
    if (!['summary', 'description', 'start'].some(key => Object.hasOwn(values, key))) throw new ValidationError('请明确要修改的日程内容。');
  }
  if (values.description && (values.description.startsWith('@') || values.description === '-' || /!\s*\[/.test(values.description))) throw new ValidationError('描述暂只支持文本；不能使用 @文件、标准输入或 Markdown 图片上传。');
  if (name === 'base.records.create' && (values.titleField || '标题') === (values.statusField || '状态')) throw new ValidationError('标题和状态不能使用同一字段。');
  return { tool: name, args: values, write: tool.write, preview: tool.preview(values), idempotencyKey: randomUUID() };
}

export function compileTool(step, context = {}) {
  const validated = validateTool(step.tool, step.args);
  return TOOLS[step.tool].build(validated.args, { ...context, idempotencyKey: step.idempotencyKey || validated.idempotencyKey });
}

export function toolCatalog() {
  return Object.entries(TOOLS).map(([name, tool]) => ({ name, description: tool.description, write: tool.write, parameters: tool.schema }));
}
