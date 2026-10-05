import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { MiMoBridgeSession, parseMiMoSse } from '../src/voice/providers/mimo-bridge.mjs';
import { createMiMoProtocol, createMiMoRealtimeProvider, startMiMoRealtimeBridge, closeMiMoRealtimeBridge, isMiMoRealtimeConfigured } from '../src/voice/providers/mimo.mjs';
import { miMoChatOptions } from '../src/voice/providers/mimo-audio.mjs';
import { validateRealtimeProvider, validateRealtimeProtocol } from '../src/voice/providers/provider-registry.mjs';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';
import { createMiMoRealtimeBridge } from '../src/voice/providers/mimo-bridge.mjs';
import { RealtimeFrontend } from '../src/voice/realtime-provider.mjs';
import { resolveRealtimeFrontendConfiguration } from '../../shared/realtime-provider-catalog.mjs';

const config = { apiBaseUrl: 'https://chat.example.invalid/v1', apiKey: 'chat-secret', chatModel: 'mimo-v2.6-flash',
  sttBaseUrl: 'https://asr.example.invalid/v1', sttApiKey: 'asr-secret', sttModel: 'mimo-v2.5-asr', sttProvider: 'mimo',
  ttsBaseUrl: 'https://tts.example.invalid/v1', ttsApiKey: 'tts-secret', ttsModel: 'mimo-v2.5-tts', ttsProvider: 'mimo', ttsVoice: 'mimo_default' };
const json = data => Response.json(data);
const reply = content => json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] });
const frame = audio => `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: audio.toString('base64') } } }] })}\n\n`;
const sse = body => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
const pcm = (value = 3000) => { const chunk = Buffer.alloc(640); for (let i = 0; i < chunk.length; i += 2) chunk.writeInt16LE(value, i); return chunk.toString('base64'); };
async function until(check) { for (let i = 0; i < 300; i++) { if (check()) return; await delay(5); } throw new Error('Mock event was not delivered.'); }
function fixture(fetcher, overrides = {}) {
  const events = [];
  const session = new MiMoBridgeSession({ config, send: event => events.push(event), fetcher, paced: false, ...overrides });
  return { session, events };
}

const runtime = {
  mimoBaseUrl: config.apiBaseUrl, mimoApiKey: config.apiKey, mimoChatModel: config.chatModel,
  mimoAsrBaseUrl: config.sttBaseUrl, mimoAsrApiKey: config.sttApiKey, mimoAsrModel: config.sttModel,
  mimoTtsBaseUrl: config.ttsBaseUrl, mimoTtsApiKey: config.ttsApiKey, mimoTtsModel: config.ttsModel, mimoTtsVoice: config.ttsVoice,
};

test('native MiMo uses original frontend instructions, tools, permissions and response correlation', () => {
  const provider = createMiMoRealtimeProvider({ runtimeConfig: runtime });
  validateRealtimeProvider(provider); validateRealtimeProtocol(createMiMoProtocol(), 'mimo');
  assert.equal(provider.key, 'mimo'); assert.equal(provider.inputSampleRate, 16000); assert.equal(provider.outputSampleRate, 24000);
  const session = provider.buildSession({ agentContext: {} });
  assert.ok(session.instructions.includes('Assistant Profile'));
  assert.ok(session.tools.some(tool => tool.name === 'get_current_time'));
  assert.ok(session.tools.some(tool => tool.name === 'notes'));
  assert.equal(session.instructions.includes('user_feishu_local'), false);
  assert.equal(session.instructions.includes('你是中文飞书助手'), false);
  assert.equal(provider.buildResultInjection('后台结果').response.tool_choice, 'none');
  assert.ok(provider.buildPermissionInjection({ id: 'permission-1', taskId: 'task-1', summary: '操作' }).item.content[0].text.includes('permission_id=permission-1'));
  const protocol = createMiMoProtocol();
  const outgoing = protocol.correlateResponseCreate(protocol.responseCreate(), 'correlation-1');
  assert.equal(protocol.responseCorrelationId({ response: outgoing.response }), 'correlation-1');
  assert.throws(() => provider.url(), /未启动/);
});

test('MiMo fast mode preserves the exact chosen TokenPlan URL and configuration signature', () => {
  const r = { ...runtime, mimoBaseUrl: 'https://token-plan-cn.xiaomimimo.com/v1/' };
  const provider = createMiMoRealtimeProvider({ runtimeConfig: r });
  const environment = { QWEN_AUDIO_REALTIME_PROVIDER: 'mimo', MIMO_CHAT_BASE_URL: r.mimoBaseUrl, MIMO_CHAT_API_KEY: r.mimoApiKey, MIMO_CHAT_MODEL: r.mimoChatModel,
    MIMO_ASR_BASE_URL: r.mimoAsrBaseUrl, MIMO_ASR_API_KEY: r.mimoAsrApiKey, MIMO_ASR_MODEL: r.mimoAsrModel, MIMO_TTS_BASE_URL: r.mimoTtsBaseUrl,
    MIMO_TTS_API_KEY: r.mimoTtsApiKey, MIMO_TTS_MODEL: r.mimoTtsModel, MIMO_TTS_VOICE: r.mimoTtsVoice };
  assert.equal(provider.configurationSignature(), resolveRealtimeFrontendConfiguration(environment).active.signature);
  assert.deepEqual(miMoChatOptions({ ...config, apiBaseUrl: 'https://token-plan-cn.xiaomimimo.com/v1' }), { thinking: { type: 'disabled' }, max_completion_tokens: 2048 });
  assert.deepEqual(miMoChatOptions(config), {});
});

test('native private bridge is idle without cloud calls, supports configured alternate providers and closes cleanly', async t => {
  t.after(() => closeMiMoRealtimeBridge());
  let cloudCalls = 0;
  assert.equal(await startMiMoRealtimeBridge({ runtimeConfig: { audioProvider: 'dashscope' } }), null);
  assert.equal(isMiMoRealtimeConfigured({ ...runtime, mimoAsrApiKey: '' }), false);
  const connection = await startMiMoRealtimeBridge({ runtimeConfig: { ...runtime, audioProvider: 'dashscope' }, fetcher: async () => { cloudCalls++; throw new Error('Unexpected cloud request'); } });
  const again = await startMiMoRealtimeBridge({ runtimeConfig: { ...runtime, audioProvider: 'mimo' } });
  assert.equal(again, connection);
  assert.match(connection.url, /^ws:\/\/127\.0\.0\.1:\d+\/realtime$/);
  assert.equal(cloudCalls, 0);
  await closeMiMoRealtimeBridge();
  assert.throws(() => createMiMoRealtimeProvider({ runtimeConfig: runtime }).url(), /未启动/);
  assert.throws(() => createMiMoRealtimeProvider({ runtimeConfig: runtime, connection: () => ({ url: 'wss://cloud.example/realtime', token: 'x'.repeat(40) }) }).url(), /本机/);
});

test('authenticated private loopback bridge works through the genuine RealtimeFrontend', async t => {
  const token = 'private-bridge-token-'.repeat(3), requests = [];
  const bridge = createMiMoRealtimeBridge({ config, WebSocketServer, bridgeToken: token, paced: false, fetcher: async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    if (url.startsWith(config.ttsBaseUrl)) return sse(frame(Buffer.alloc(960)) + 'data: [DONE]\n\n');
    return reply('原生语音回复');
  } });
  const address = await bridge.listen();
  let frontend;
  t.after(async () => { frontend?.close(); await bridge.close(); });
  const url = `ws://127.0.0.1:${address.port}/realtime`;
  const rejected = new WebSocket(url);
  rejected.on('error', () => {});
  rejected.on('unexpected-response', (_request, response) => response.resume());
  assert.equal((await once(rejected, 'unexpected-response'))[1].statusCode, 403); rejected.terminate();
  const provider = createMiMoRealtimeProvider({ runtimeConfig: runtime, connection: () => ({ url, token }) });
  const events = [];
  frontend = new RealtimeFrontend({ provider, onEvent: event => events.push(event), onError: error => { throw error; } });
  await frontend.connect(); assert.equal(frontend.ready, true);
  await frontend.sendUserText('你好');
  await until(() => events.some(event => event.type === 'response.done'));
  assert.ok(events.some(event => event.type === 'response.text.done' && event.text === '原生语音回复'));
  assert.ok(events.some(event => event.type === 'response.audio.delta'));
  const chat = requests.find(request => request.url.startsWith(config.apiBaseUrl));
  assert.ok(chat.body.tools.some(tool => tool.function.name === 'notes'));
  assert.ok(chat.body.messages[0].content.includes('Assistant Profile'));
  frontend.setInputMuted(true);
  await frontend.speak('后台已完成');
  await until(() => events.filter(event => event.type === 'response.done').length === 2);
});


test('SSE parser handles UTF-8 split across transport packets, comments, CRLF and done', async () => {
  const bytes = Buffer.from(': heartbeat\r\ndata: {"text":"你好"}\r\n\r\ndata: [DONE]\n\ndata: {"ignored":true}\n\n');
  async function* chunks() { for (let i = 0; i < bytes.length; i++) yield bytes.subarray(i, i + 1); }
  const output = []; for await (const value of parseMiMoSse(chunks())) output.push(value);
  assert.deepEqual(output, [{ text: '你好' }]);
  await assert.rejects(async () => { for await (const value of parseMiMoSse([Buffer.from('data: invalid\n\n')])) void value; }, /JSON/);
});


test('ASR WAV is bound to ASR host/key; resulting 24k PCM is bounded even when SSE splits odd bytes', async () => {
  const requests = [];
  const f = fixture(async (url, init) => {
    const body = JSON.parse(init.body); requests.push({ url, init, body });
    if (url.startsWith(config.sttBaseUrl)) return reply('查看我今天的日程');
    if (url.startsWith(config.apiBaseUrl)) return reply('今天没有日程。');
    return sse(frame(Buffer.alloc(961, 1)) + frame(Buffer.alloc(959, 1)) + 'data: [DONE]\n\n');
  });
  try {
    for (let i = 0; i < 8; i++) f.session.receive({ type: 'input_audio_buffer.append', audio: pcm() });
    f.session.receive({ type: 'input_audio_buffer.commit' });
    await until(() => f.events.some(event => event.type === 'response.done'));
    assert.ok(f.events.some(event => event.type === 'conversation.item.input_audio_transcription.completed' && event.transcript === '查看我今天的日程'));
    const asr = requests.find(r => r.url.startsWith(config.sttBaseUrl));
    assert.equal(asr.init.headers.Authorization, 'Bearer asr-secret'); assert.equal(asr.init.redirect, 'error');
    assert.match(asr.body.messages[0].content[0].input_audio.data, /^data:audio\/wav;base64,UklGR/);
    const tts = requests.find(r => r.url.startsWith(config.ttsBaseUrl));
    assert.equal(tts.init.headers.Authorization, 'Bearer tts-secret'); assert.equal(tts.body.stream, true); assert.equal(tts.body.audio.format, 'pcm16');
    const audio = f.events.filter(event => event.type === 'response.audio.delta').map(event => Buffer.from(event.delta, 'base64'));
    assert.equal(Buffer.concat(audio).length, 1920); assert.ok(audio.every(chunk => chunk.length <= 960 && chunk.length % 2 === 0));
    assert.equal(f.events.at(-1).response.status, 'completed');
  } finally { f.session.close(); }
});

test('mute discards the unfinished turn and closes its speech lifecycle without ASR upload', async () => {
  let uploads = 0; const f = fixture(async () => { uploads++; return reply('ignored'); });
  try {
    f.session.receive({ type: 'input_audio_buffer.append', audio: pcm() });
    f.session.receive({ type: 'input.mute' });
    for (let i = 0; i < 10; i++) f.session.receive({ type: 'input_audio_buffer.append', audio: pcm() });
    await delay(20);
    assert.equal(uploads, 0); assert.equal(f.session.audioBytes, 0);
    assert.ok(f.events.some(event => event.type === 'input_audio_buffer.speech_stopped'));
    assert.ok(f.events.some(event => event.type === 'conversation.item.input_audio_transcription.failed'));
  } finally { f.session.close(); }
});

test('VAD retains 120 ms of pre-roll for tiny browser frames and keeps the complete first voiced chunk', () => {
  for (const packetBytes of [2, 84, 640, 12800]) {
    const f = fixture(async () => { throw new Error('Uncommitted capture must not upload.'); });
    try {
      for (let total = 0; total < 12800; total += packetBytes) {
        f.session.receive({ type: 'input_audio_buffer.append', audio: Buffer.alloc(Math.min(packetBytes, 12800 - total)).toString('base64') });
      }
      assert.equal(f.session.preRollBytes, 3840);
      assert.equal(Buffer.concat(f.session.preRoll).length, 3840);
      const voice = Buffer.alloc(5120); for (let offset = 0; offset < voice.length; offset += 2) voice.writeInt16LE(3000, offset);
      f.session.receive({ type: 'input_audio_buffer.append', audio: voice.toString('base64') });
      const captured = Buffer.concat(f.session.audioChunks);
      assert.equal(captured.length, 3840 + voice.length);
      assert.deepEqual(captured.subarray(3840), voice);
      assert.equal(f.session.voicedMs, 160);
      f.session.receive({ type: 'input.mute' });
      assert.equal(f.session.preRollBytes, 0); assert.equal(f.session.audioBytes, 0);
    } finally { f.session.close(); }
  }
});

test('response cancellation aborts in-flight chat and rejects a late completion', async () => {
  let finish, signal;
  const f = fixture(async (url, init) => { signal = init.signal; return new Promise(yes => { finish = yes; }); });
  try {
    const pending = f.session.respond({ metadata: { correlation_id: 'cancel-test' } });
    f.session.cancelResponse(); assert.equal(signal.aborted, true);
    finish(reply('这个迟到的回答不能播放')); await pending;
    assert.equal(f.events.filter(e => e.type === 'response.done').length, 1);
    assert.equal(f.events.at(-1).response.status, 'cancelled');
    assert.equal(f.events.at(-1).response.metadata.correlation_id, 'cancel-test');
    assert.equal(f.events.filter(e => e.type === 'response.text.delta' || e.type === 'response.audio.delta').length, 0);
  } finally { f.session.close(); }
});

test('barge-in cancels real streaming TTS and fences late audio before a new turn', async () => {
  let streamController;
  const f = fixture(async url => url.startsWith(config.ttsBaseUrl)
    ? sse(new ReadableStream({ start(controller) { streamController = controller; controller.enqueue(Buffer.from(frame(Buffer.alloc(960)))); } }))
    : reply('旧回复正在播放'));
  try {
    const pending = f.session.respond({ metadata: { correlation_id: 'old-voice' } });
    await until(() => f.events.some(event => event.type === 'response.audio.delta'));
    const oldId = f.events.find(event => event.type === 'response.created').response.id;
    f.session.receive({ type: 'input_audio_buffer.append', audio: pcm() });
    assert.equal(f.events.find(event => event.type === 'response.done' && event.response.id === oldId).response.status, 'cancelled');
    streamController.enqueue(Buffer.from(frame(Buffer.alloc(960, 2)))); streamController.close();
    await pending;
    assert.equal(f.events.filter(event => event.type === 'response.audio.delta' && event.response_id === oldId).length, 1);
    assert.ok(f.events.some(event => event.type === 'input_audio_buffer.speech_started'));
  } finally { f.session.close(); }
});

test('native frontend tool results are consumed once and never become a user command', async () => {
  const f = fixture(async () => json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, reasoning_content: 'opaque-provider-tool-context', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'spawn_thinking', arguments: '{"objective":"查看日程"}' } }] } }] }));
  try {
    f.session.receive({ type: 'session.update', session: { tools: [{ type: 'function', name: 'spawn_thinking' }] } });
    await f.session.respond({});
    assert.equal(f.events.filter(e => e.type === 'response.function_call_arguments.done').length, 1);
    f.session.receive({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'call-1', output: '{"status":"queued"}' } });
    f.session.receive({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'call-1', output: 'duplicate' } });
    assert.equal(f.session.history.filter(message => message.role === 'tool').length, 1);
    assert.equal(f.session.calls.size, 0);
    assert.equal(f.session.history.find(message => message.role === 'assistant').reasoning_content, 'opaque-provider-tool-context');
    assert.equal(JSON.stringify(f.events).includes('opaque-provider-tool-context'), false);
  } finally { f.session.close(); }
});



test('TTS failure preserves text response and never exposes service credentials', async () => {
  const f = fixture(async url => url.startsWith(config.ttsBaseUrl) ? new Response(JSON.stringify({ error: { message: `Denied ${config.ttsApiKey}` } }), { status: 401 }) : reply('文字结果仍然可用。'));
  try {
    await f.session.respond({});
    assert.ok(f.events.some(e => e.type === 'response.text.done' && e.text.includes('文字结果')));
    assert.equal(f.events.at(-1).response.status, 'completed');
    assert.equal(JSON.stringify(f.events).includes(config.ttsApiKey), false);
  } finally { f.session.close(); }
});

test('a provider cannot invoke tools from a passive result or permission announcement', async () => {
  const f = fixture(async () => json({ choices: [{ message: { content: '', tool_calls: [{ id: 'forbidden', type: 'function', function: { name: 'spawn_thinking', arguments: '{"objective":"新建任务"}' } }] } }] }));
  try {
    f.session.receive({ type: 'session.update', session: { tools: [{ type: 'function', name: 'spawn_thinking' }] } });
    await f.session.respond({ tool_choice: 'none' });
    assert.equal(f.events.filter(event => event.type === 'response.function_call_arguments.done').length, 0);
    assert.equal(f.events.at(-1).response.status, 'failed');
  } finally { f.session.close(); }
});
