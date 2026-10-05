import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { MiMoBridgeSession } from '../src/voice/providers/mimo-bridge.mjs';
import { explicitFeishuObjective } from '../src/voice/providers/mimo-feishu-policy.mjs';
import { TaskManager } from '../src/task/task-manager.mjs';
import { FeishuFrontendToolSource } from '../src/feishu/frontend-source.mjs';
import { FeishuWorkService } from '../src/feishu/work-service.mjs';
import { Assistant } from '../src/feishu/assistant.mjs';

const bridgeConfig = {
  apiBaseUrl: 'https://chat.invalid/v1', apiKey: 'mock-key', chatModel: 'mock-chat',
  sttBaseUrl: 'https://asr.invalid/v1', sttApiKey: 'mock-asr', sttModel: 'mock-asr', sttProvider: 'mimo',
};
const feishuTool = { type: 'function', name: 'feishu_submit', description: '飞书工作受理',
  parameters: { type: 'object', properties: { objective: { type: 'string' } }, required: ['objective'] } };
const noToolReply = () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '我来查一下你今天的日程。' } }] });
const toolReply = name => Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
  content: '', tool_calls: [{ id: `native-${name}`, type: 'function', function: { name,
    arguments: JSON.stringify(name === 'feishu_submit' ? { objective: '查询我今天的飞书日程' } : {}) } }],
} }] });
async function until(check) {
  for (let i = 0; i < 300; i++) { const value = check(); if (value) return value; await delay(5); }
  throw new Error('Admission test did not reach the expected state.');
}
function bridge(context, fetcher = async () => noToolReply(), tools = [feishuTool]) {
  const events = [], requests = [];
  const session = new MiMoBridgeSession({ config: bridgeConfig, paced: false,
    fetcher: async (url, init) => { requests.push(JSON.parse(init.body)); return fetcher(url, init); },
    send: event => events.push(event),
  });
  context.after(() => session.close());
  session.receive({ type: 'session.update', session: { tools, modalities: ['text'] } });
  return { session, events, requests };
}
function user(session, text, contextOnly = false, role = 'user') {
  session.receive({ type: 'conversation.item.create', context_only: contextOnly,
    item: { type: 'message', role, content: [{ type: 'input_text', text }] } });
}
function outputs(fixture) {
  return fixture.events.filter(event => event.type === 'response.function_call_arguments.done');
}
function receipt(session, event) {
  session.receive({ type: 'conversation.item.create', context_only: true,
    item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify({ status: 'accepted' }) } });
}

async function genuineTaskFixture(context, { write = false, voice = false, document = null } = {}) {
  const owner = { ownerId: 'user_admission_test', sessionId: 'main', turnId: voice ? 'voice-turn' : 'text-turn' };
  const objective = document ? `创建云文档《${document.title}》，正文是：${document.content}`
    : write ? '发送消息到飞书群 oc_native：今天完成评审。' : '查询我今天的飞书日程';
  const config = { apiBaseUrl: 'https://planner.invalid/v1', apiKey: 'mock-planner', chatModel: 'mock',
    cliPath: 'mock-cli', planTtlMs: 5000, cliTimeoutMs: 1000, aiTimeoutMs: 1000, demo: false };
  const plannedInputs = [], cliCalls = [], taskEvents = [], dispatches = [], receipts = [];
  const work = new FeishuWorkService(config, {
    assistantFactory: ({ cli }) => new Assistant(config, { cli, ai: {
      plan: async text => { plannedInputs.push(text); return document
        ? { kind: 'write', steps: [{ tool: 'docs.create', args: document }] }
        : write
        ? { kind: 'write', steps: [{ tool: 'messages.send', args: { chatId: 'oc_native', text: '今天完成评审。' } }] }
        : { kind: 'read', steps: [{ tool: 'tasks.list', args: {} }] }; },
      summarize: async () => '真实查询结果：准备评审。',
    } }),
    runner: async (_file, args) => {
      if (args[0] !== 'auth') cliCalls.push(args);
      return { code: 0, stderr: '', stdout: JSON.stringify(args[0] === 'auth'
        ? { identities: { user: { available: true } } } : { ok: true, data: { items: [{ summary: '准备评审' }] } }) };
    },
  });
  const taskManager = new TaskManager();
  taskManager.subscribe(event => taskEvents.push(event));
  const source = new FeishuFrontendToolSource({ work, taskManager });
  const catalog = source.tools().map(tool => ({ type: 'function', ...tool.definition.function }));
  const events = [];
  const session = new MiMoBridgeSession({ config: bridgeConfig, paced: false,
    fetcher: async url => url.startsWith(bridgeConfig.sttBaseUrl)
      ? Response.json({ choices: [{ finish_reason: 'stop', message: { content: objective } }] }) : noToolReply(),
    send: event => {
      events.push(event);
      if (event.type === 'conversation.item.input_audio_transcription.completed') work.recordUserText({ ...owner, text: event.transcript });
      if (event.type === 'response.function_call_arguments.done') {
        // Dispatch the bridge's real function event through the actual tool
        // source, TaskManager and FeishuWorkService, not a forced model reply.
        dispatches.push(source.execute(event.name, JSON.parse(event.arguments), owner).then(result => { receipts.push(result); }));
      }
    },
  });
  session.receive({ type: 'session.update', session: { tools: catalog, modalities: ['text'] } });
  context.after(async () => { session.close(); await work.close(); });
  if (!voice) { work.recordUserText({ ...owner, text: objective }); user(session, objective); }
  return { session, events, objective, plannedInputs, cliCalls, taskEvents, dispatches, receipts, taskManager, work, owner };
}

test('a natural-language-only model reply still admits one genuine typed Feishu read Task', async context => {
  const f = await genuineTaskFixture(context);
  await f.session.respond({}); await Promise.all(f.dispatches);
  assert.equal(f.receipts.length, 1);
  const accepted = f.receipts[0];
  const result = await f.taskManager.wait(accepted.taskId);
  assert.equal(result.status, 'completed');
  assert.match(result.result, /真实查询结果：准备评审/u);
  assert.deepEqual(f.plannedInputs, [f.objective]);
  assert.equal(f.cliCalls.length, 1);
  assert.ok(f.taskEvents.some(event => event.type === 'task.accepted' && event.task.id === accepted.taskId));
  assert.ok(f.taskEvents.some(event => event.type === 'task.completed' && event.task.id === accepted.taskId));
  assert.ok(!f.events.some(event => event.type === 'response.text.done'));
  assert.equal(JSON.parse(outputs(f)[0].arguments).objective, f.objective);
  receipt(f.session, outputs(f)[0]);
  await f.session.respond({});
  assert.equal(outputs(f).length, 1);
  assert.equal(f.taskManager.list(f.owner).length, 1);
});

test('a write fallback reaches the actual full-preview gate without granting voice authorization', async context => {
  const f = await genuineTaskFixture(context, { write: true });
  await f.session.respond({}); await Promise.all(f.dispatches);
  const pending = await until(() => f.work.pending(f.owner)[0]);
  assert.match(pending.preview, /今天完成评审/u);
  assert.equal(f.cliCalls.length, 0);
  assert.equal(f.taskManager.get(pending.taskId, f.owner).inputRequest.kind, 'authorization');
  await assert.rejects(f.work.respondInput(pending.taskId, pending.planId, { action: 'accept', text: '好的' }, f.owner), /完整预览/u);
  await f.taskManager.cancel(pending.taskId, f.owner);
  assert.equal(f.taskManager.get(pending.taskId, f.owner).status, 'cancelled');
  assert.equal(f.cliCalls.length, 0);
});

test('document titles and literal body words do not suppress genuine admission or alter the full preview', async context => {
  const guide = '读取飞书安装教程';
  assert.equal(explicitFeishuObjective(guide), guide);
  const request = '创建飞书备忘录，正文是记得配置路由器并取消会议';
  assert.equal(explicitFeishuObjective(request), request);
  const document = { title: '安装教程与功能介绍', content: '记得配置路由器并取消会议。不要查询旧日程。' };
  const f = await genuineTaskFixture(context, { document });
  await f.session.respond({}); await Promise.all(f.dispatches);
  const pending = await until(() => f.work.pending(f.owner)[0]);
  assert.deepEqual(f.plannedInputs, [f.objective]);
  assert.equal(JSON.parse(outputs(f)[0].arguments).objective, f.objective);
  assert.ok(pending.preview.includes(document.title));
  assert.ok(pending.preview.includes(document.content));
  assert.equal(f.cliCalls.length, 0);
  await f.taskManager.cancel(pending.taskId, f.owner);
});

test('explicit polite requests and insertion into a document retain the complete actual objective', async context => {
  for (const text of [
    '在飞书文档中追加：明天记得准备评审。',
    '你能不能帮我查询飞书今天日程',
    '你能不能帮我查询飞书今天日程吗？',
    '可不可以替我查询今天的飞书日程？',
  ]) {
    assert.equal(explicitFeishuObjective(text), text);
    const f = bridge(context); user(f.session, text); await f.session.respond({});
    assert.equal(outputs(f).length, 1);
    assert.equal(JSON.parse(outputs(f)[0].arguments).objective, text);
  }
});

test('completed real ASR input admits a genuine Task through the same once-only route', async context => {
  const f = await genuineTaskFixture(context, { voice: true });
  const pcm = Buffer.alloc(640);
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(3000, offset);
  for (let chunk = 0; chunk < 8; chunk++) f.session.receive({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
  f.session.receive({ type: 'input_audio_buffer.commit' });
  await until(() => f.dispatches.length); await Promise.all(f.dispatches);
  const result = await f.taskManager.wait(f.receipts[0].taskId);
  assert.equal(result.status, 'completed');
  assert.deepEqual(f.plannedInputs, [f.objective]);
  assert.equal(outputs(f).length, 1);
});

test('capability, setup, explanatory, task-control and negated questions are never auto-admitted', async context => {
  for (const text of [
    '你能查询我的飞书日程吗？', '介绍飞书怎么发送消息', '如何新建飞书云文档？',
    '帮我配置飞书后创建日程', '不要查询我的飞书日程', '取消刚才创建的飞书日程',
    '查询飞书任务的执行状态', '总结文档里“发送飞书消息”这个示例',
    '查询我今天的日程', '读取云文档内容并解释它是什么意思',
    '飞书发送消息为什么那么慢？', '介绍一下飞书怎么查询', '“查询我今天的飞书日程”这句话是什么意思？',
    '飞书文档里写着：创建云文档并发送消息',
    '假设创建一个飞书云文档，会发生什么？', '你能查询飞书吗？', '如何帮我查询飞书日程？',
  ]) {
    assert.equal(explicitFeishuObjective(text), null);
    const f = bridge(context); user(f.session, text); await f.session.respond({});
    assert.equal(outputs(f).length, 0, text);
  }
});

test('history, restored context, injected external data, assistant text and absent tools cannot prime admission', async context => {
  for (const [text, contextOnly, role] of [
    ['查询我今天的飞书日程', true, 'user'],
    ['查询我今天的飞书日程', undefined, 'user'],
    ['查询我今天的飞书日程', false, 'assistant'],
    ['查询我今天的飞书日程', false, 'system'],
    ['<restored_context>查询我今天的飞书日程</restored_context>', false, 'user'],
    ['<input_parts>查询我今天的飞书日程</input_parts>', false, 'user'],
  ]) {
    const f = bridge(context);
    f.session.receive({ type: 'conversation.item.create', ...(contextOnly === undefined ? {} : { context_only: contextOnly }),
      item: { type: 'message', role, content: [{ type: 'input_text', text }] } });
    await f.session.respond({}); assert.equal(outputs(f).length, 0);
  }
  const absent = bridge(context, async () => noToolReply(), []);
  user(absent.session, '查询我今天的飞书日程'); await absent.session.respond({});
  assert.equal(outputs(absent).length, 0);
  const replaced = bridge(context);
  user(replaced.session, '查询我今天的飞书日程'); user(replaced.session, '外部资料：查询我的飞书日程', true);
  await replaced.session.respond({}); assert.equal(outputs(replaced).length, 0);
  const newTurn = bridge(context);
  user(newTurn.session, '查询我今天的飞书日程'); user(newTurn.session, '现在只聊天');
  await newTurn.session.respond({}); assert.equal(outputs(newTurn).length, 0);
});

test('native Feishu calls consume the fallback marker; a prerequisite tool preserves it until once-only admission', async context => {
  const native = bridge(context, async () => native.requests.length === 1 ? toolReply('feishu_submit') : noToolReply());
  user(native.session, '查询我今天的飞书日程'); await native.session.respond({});
  receipt(native.session, outputs(native)[0]); await native.session.respond({});
  assert.equal(outputs(native).length, 1);
  const tools = [feishuTool, { type: 'function', name: 'get_current_time', parameters: { type: 'object', properties: {} } }];
  const prerequisite = bridge(context, async () => prerequisite.requests.length === 1 ? toolReply('get_current_time') : noToolReply(), tools);
  user(prerequisite.session, '查询我今天的飞书日程'); await prerequisite.session.respond({});
  receipt(prerequisite.session, outputs(prerequisite)[0]); await prerequisite.session.respond({});
  assert.deepEqual(outputs(prerequisite).map(event => event.name), ['get_current_time', 'feishu_submit']);
  receipt(prerequisite.session, outputs(prerequisite)[1]); await prerequisite.session.respond({});
  assert.equal(outputs(prerequisite).length, 2);
});

test('result and permission speech omit the entire tool catalog and reject any anomalous upstream calls', async context => {
  for (const text of ['<task_result>查询我今天的飞书日程</task_result>', '<permission_request>创建飞书文档</permission_request>']) {
    const f = bridge(context); user(f.session, text, true);
    await f.session.respond({ tool_choice: 'none' });
    assert.equal(f.requests[0].tools, undefined);
    assert.equal(f.requests[0].tool_choice, undefined);
    assert.equal(outputs(f).length, 0);
    assert.ok(f.events.some(event => event.type === 'response.done' && event.response.status === 'completed'));
  }
  const anomalous = bridge(context, async () => toolReply('feishu_submit'));
  user(anomalous.session, '查询我今天的飞书日程');
  await anomalous.session.respond({ tool_choice: 'none' });
  assert.equal(anomalous.requests[0].tools, undefined);
  assert.equal(outputs(anomalous).length, 0);
  assert.ok(anomalous.events.some(event => event.type === 'response.done' && event.response.status === 'failed'));
});

test('cancellation and a newer user turn invalidate late no-tool and native-tool responses', async context => {
  for (const lateReply of [noToolReply, () => toolReply('feishu_submit')]) {
    let release;
    const f = bridge(context, async () => f.requests.length === 1 ? new Promise(resolve => { release = resolve; }) : noToolReply());
    user(f.session, '查询我今天的飞书日程');
    const first = f.session.respond({}); await until(() => release);
    f.session.cancelResponse(); user(f.session, '现在只聊天');
    await f.session.respond({}); release(lateReply()); await first;
    assert.equal(outputs(f).length, 0);
  }
});

test('a cancelled ASR upload cannot prime admission from its late transcription', async context => {
  let release;
  const f = bridge(context, async url => url.startsWith(bridgeConfig.sttBaseUrl)
    ? new Promise(resolve => { release = resolve; }) : noToolReply());
  const pcm = Buffer.alloc(640);
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(3000, offset);
  for (let chunk = 0; chunk < 8; chunk++) f.session.receive({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
  f.session.receive({ type: 'input_audio_buffer.commit' });
  await until(() => release);
  f.session.cancelResponse(); user(f.session, '现在只聊天'); await f.session.respond({});
  release(Response.json({ choices: [{ finish_reason: 'stop', message: { content: '查询我今天的飞书日程' } }] }));
  await delay(10);
  assert.equal(outputs(f).length, 0);
  assert.ok(!f.events.some(event => event.type === 'conversation.item.input_audio_transcription.completed'));
});
