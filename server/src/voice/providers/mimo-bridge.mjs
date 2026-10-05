import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pcm16ToWav, decodeBase64Audio, redact, miMoChatOptions } from './mimo-audio.mjs';
import { explicitFeishuObjective } from './mimo-feishu-policy.mjs';
import { miMoSpeechSegments, MIMO_TTS_SEGMENT_AUDIO_BYTES } from './mimo-speech-segments.mjs';

const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const MAX_INPUT_BYTES = 16000 * 2 * 30;
const PRE_ROLL_BYTES = 16000 * 2 * 0.12;
// Native AudioWorklet input arrives once per 128 source samples, even after
// resampling. Bound PCM throughput separately from that small-packet cadence.
const MAX_AUDIO_PACKETS_PER_SECOND = 2048;
const MAX_AUDIO_BYTES_PER_SECOND = 16000 * 2 * 3;
const MAX_CONTROL_PACKETS_PER_SECOND = 250;
const MAX_WIRE_BYTES_PER_SECOND = 512 * 1024;
const textOf = item => (item.content || []).map(part => part.text || part.transcript || '').join('\n');

async function responseBytes(response, limit = 2 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body || []) { size += chunk.length; if (size > limit) throw new Error('模型响应超过大小上限。'); chunks.push(chunk); }
  return Buffer.concat(chunks, size);
}

export async function* parseMiMoSse(body) {
  const decoder = new TextDecoder(); let buffer = '', data = [], total = 0;
  const record = () => { const value = data.join('\n'); data = []; return value; };
  for await (const chunk of body || []) {
    total += chunk.length; if (total > 16 * 1024 * 1024) throw new Error('流式语音响应超过大小上限。');
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 262144) throw new Error('流式事件过大。');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      else if (!line && data.length) {
        const value = record(); if (value === '[DONE]') return;
        try { yield JSON.parse(value); } catch { throw new Error('流式服务返回无效 JSON。'); }
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.startsWith('data:')) data.push(buffer.slice(5).trim());
  if (data.length) { const value = record(); if (value !== '[DONE]') { try { yield JSON.parse(value); } catch { throw new Error('流式响应不完整。'); } } }
}

export class MiMoBridgeSession {
  constructor({ config, send, fetcher = fetch, paced = true, clock = Date.now, sleep = delay }) {
    this.config = config; this.sendFrame = send; this.fetcher = fetcher; this.paced = paced;
    this.audioClock = clock; this.audioSleep = sleep;
    this.settings = { tools: [], turn_detection: { silence_duration_ms: 750, threshold: 0.018 } };
    this.history = []; this.calls = new Set(); this.muted = false; this.closed = false;
    this.audioChunks = []; this.audioBytes = 0; this.preRoll = []; this.preRollBytes = 0; this.speechId = null; this.voicedMs = 0; this.sampleMs = 0;
    this.generation = 0; this.inputGeneration = 0; this.active = null; this.asrController = null; this.vadTimer = null;
    this.pendingFeishuInput = null;
  }
  emit(event) { if (!this.closed) this.sendFrame({ event_id: id('event'), ...event }); }
  error(message, eventId) { this.emit({ type: 'error', error: { type: 'mimo_bridge_error', message: redact(this.config, message), ...(eventId ? { event_id: eventId } : {}) } }); }
  append(message) {
    this.history.push(message);
    while (this.history.length > 48 || JSON.stringify(this.history).length > 100000) {
      this.history.shift(); while (this.history.length && this.history[0].role !== 'user') this.history.shift();
    }
  }
  async upstream(base, key, path, body, controller, json = true) {
    if (!base || !key) throw new Error('请先在接口设置中填写对应服务地址和密钥。');
    const response = await this.fetcher(`${base}${path}`, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${key}`, ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(body) : body, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]) });
    if (!response.ok) {
      const payload = await responseBytes(response);
      let reason = '请检查配置、套餐额度和服务状态。';
      try { reason = JSON.parse(payload.toString('utf8')).error?.message || reason; } catch {}
      throw new Error(`MiMo 服务错误 ${response.status}：${String(reason).slice(0, 300)}`);
    }
    return response;
  }
  async jsonRequest(base, key, path, body, controller, json = true) {
    const bytes = await responseBytes(await this.upstream(base, key, path, body, controller, json));
    try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error('模型服务没有返回有效 JSON。'); }
  }
  receive(message) {
    if (!message || typeof message !== 'object' || this.closed) return;
    switch (message.type) {
      case 'session.update': {
        const update = message.session || {};
        if (typeof update.instructions === 'string' && update.instructions.length > 128000) throw new Error('会话提示内容过大。');
        if (update.tools && (!Array.isArray(update.tools) || update.tools.length > 80)) throw new Error('工具目录过大。');
        this.settings = { ...this.settings, ...update };
        this.emit({ type: 'session.updated', session: { id: this.sessionId, input_audio_format: 'pcm16', output_audio_format: 'pcm16', ...this.settings, instructions: undefined, tools: undefined } });
        break;
      }
      case 'conversation.item.create': {
        const item = message.item;
        if (!item || typeof item !== 'object') throw new Error('缺少会话项目。');
        const itemId = item.id || id('item');
        if (item.type === 'function_call_output') {
          if (this.calls.delete(item.call_id)) this.append({ role: 'tool', tool_call_id: item.call_id, content: String(item.output || '').slice(0, 30000) });
        } else if (item.type === 'message' && ['user', 'assistant', 'system'].includes(item.role)) {
          const text = textOf(item); if (text.length > 40000) throw new Error('对话项目过大。');
          // User identity and authorization belong to the authenticated Gateway.
          if (text) {
            if (item.role === 'user' || item.role === 'system') {
              this.pendingFeishuInput = null;
              if (item.role === 'user' && message.context_only === false) this.markFeishuInput(text);
            }
            this.append({ role: item.role === 'system' ? 'user' : item.role, content: text });
          }
        } else throw new Error('此语音前台只接收文字、语音和工具回执。');
        this.emit({ type: 'conversation.item.created', item: { ...item, id: itemId } });
        break;
      }
      case 'input_audio_buffer.append': this.appendAudio(message.audio); break;
      case 'input_audio_buffer.commit': this.commitAudio(); break;
      case 'input_audio_buffer.clear': this.discardAudio(); break;
      case 'input.mute': this.muted = true; this.discardAudio(); break;
      case 'input.unmute': this.muted = false; break;
      case 'response.create': void this.respond(message.response || {}); break;
      case 'response.cancel': this.cancelResponse(); break;
      case 'session.close': this.close(); break;
      default: this.error(`不支持的本机语音事件：${String(message.type).slice(0, 80)}`, message.event_id);
    }
  }
  resetAudio() { clearTimeout(this.vadTimer); this.vadTimer = null; this.audioChunks = []; this.audioBytes = 0; this.preRoll = []; this.preRollBytes = 0; this.speechId = null; this.voicedMs = 0; }
  discardAudio() {
    if (this.speechId) {
      this.emit({ type: 'input_audio_buffer.speech_stopped', item_id: this.speechId, audio_end_ms: Math.round(this.sampleMs) });
      this.emit({ type: 'conversation.item.input_audio_transcription.failed', item_id: this.speechId, error: { message: '录音已取消。' } });
    }
    this.resetAudio();
  }
  appendAudio(value) {
    if (this.muted) return;
    if (typeof value !== 'string' || !value.length || value.length > 65536 || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('音频分片编码不正确。');
    const bytes = Buffer.from(value, 'base64');
    if (!bytes.length || bytes.length % 2 || bytes.toString('base64') !== value) throw new Error('音频需要单声道 PCM16。');
    const milliseconds = bytes.length / 32; this.sampleMs += milliseconds;
    let squares = 0; for (let offset = 0; offset < bytes.length; offset += 2) squares += (bytes.readInt16LE(offset) / 32768) ** 2;
    const rms = Math.sqrt(squares / (bytes.length / 2));
    const configured = Number(this.settings.turn_detection?.threshold);
    const threshold = Number.isFinite(configured) ? Math.min(0.1, Math.max(0.005, configured)) : 0.018;
    const voiced = rms >= threshold;
    if (!this.speechId) {
      if (!voiced) {
        this.preRoll.push(bytes); this.preRollBytes += bytes.length;
        while (this.preRollBytes > PRE_ROLL_BYTES) {
          const first = this.preRoll[0], excess = this.preRollBytes - PRE_ROLL_BYTES;
          if (first.length <= excess) { this.preRoll.shift(); this.preRollBytes -= first.length; }
          else { this.preRoll[0] = first.subarray(excess); this.preRollBytes -= excess; }
        }
        return;
      }
      this.cancelResponse(); this.speechId = id('item'); this.audioChunks = [...this.preRoll, bytes];
      this.audioBytes = this.preRollBytes + bytes.length; this.preRoll = []; this.preRollBytes = 0;
      this.emit({ type: 'input_audio_buffer.speech_started', item_id: this.speechId, audio_start_ms: Math.round(this.sampleMs - milliseconds) });
    } else { this.audioChunks.push(bytes); this.audioBytes += bytes.length; }
    if (voiced) this.voicedMs += milliseconds;
    clearTimeout(this.vadTimer);
    if (this.audioBytes >= MAX_INPUT_BYTES) { this.commitAudio(); return; }
    const pause = Math.min(1500, Math.max(350, Number(this.settings.turn_detection?.silence_duration_ms) || 750));
    if (voiced) this.lastVoiceAt = Date.now();
    if (!voiced && Date.now() - this.lastVoiceAt >= pause) this.commitAudio();
    else this.vadTimer = setTimeout(() => this.commitAudio(), pause);
  }
  commitAudio() {
    if (!this.speechId) return;
    const itemId = this.speechId, pcm = Buffer.concat(this.audioChunks).subarray(0, MAX_INPUT_BYTES), voicedMs = this.voicedMs;
    this.emit({ type: 'input_audio_buffer.speech_stopped', item_id: itemId, audio_end_ms: Math.round(this.sampleMs) });
    this.resetAudio();
    if (pcm.length < 3200 || voicedMs < 100) { this.emit({ type: 'conversation.item.input_audio_transcription.failed', item_id: itemId, error: { message: '录音过短。' } }); return; }
    this.emit({ type: 'input_audio_buffer.committed', item_id: itemId });
    void this.transcribe(pcm, itemId);
  }
  async transcribe(pcm, itemId) {
    const generation = ++this.inputGeneration;
    this.asrController?.abort(); const controller = new AbortController(); this.asrController = controller;
    try {
      const wav = pcm16ToWav(pcm); let response;
      if (this.config.sttProvider === 'mimo') {
        response = await this.jsonRequest(this.config.sttBaseUrl, this.config.sttApiKey, '/chat/completions', { model: this.config.sttModel, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${wav.toString('base64')}`, format: 'wav' } }] }], asr_options: { language: 'zh' }, stream: false }, controller);
        if (['length', 'content_filter'].includes(response.choices?.[0]?.finish_reason)) throw new Error('识别结果不完整。');
      } else {
        const form = new FormData(); form.append('model', this.config.sttModel); form.append('language', 'zh'); form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
        response = await this.jsonRequest(this.config.sttBaseUrl, this.config.sttApiKey, '/audio/transcriptions', form, controller, false);
      }
      const text = response.text || response.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('没有识别出有效语音。');
      if (this.closed || generation !== this.inputGeneration || controller.signal.aborted) return;
      this.append({ role: 'user', content: text.trim() });
      this.markFeishuInput(text.trim());
      this.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, content_index: 0, transcript: text.trim() });
      await this.respond({});
    } catch (error) {
      if (!controller.signal.aborted && generation === this.inputGeneration) {
        this.emit({ type: 'conversation.item.input_audio_transcription.failed', item_id: itemId, error: { message: redact(this.config, error.message) } }); this.error(error.message);
      }
    } finally { if (this.asrController === controller) this.asrController = null; }
  }
  cancelResponse() {
    this.pendingFeishuInput = null;
    this.generation++; this.inputGeneration++; this.asrController?.abort(); this.asrController = null;
    const active = this.active; if (!active) return;
    active.controller.abort(); this.active = null;
    this.emit({ type: 'response.done', response: { id: active.id, status: 'cancelled', output: [], metadata: active.metadata } });
  }
  markFeishuInput(text) {
    const objective = explicitFeishuObjective(text);
    this.pendingFeishuInput = objective ? { objective } : null;
  }
  async respond(options) {
    if (this.closed) return;
    if (this.active) { this.error('another response is in progress'); return; }
    const generation = this.generation, active = { id: id('response'), controller: new AbortController(), metadata: options.metadata || {} };
    const userInput = this.pendingFeishuInput;
    this.active = active;
    const current = () => !this.closed && this.active === active && generation === this.generation && !active.controller.signal.aborted;
    this.emit({ type: 'response.created', response: { id: active.id, status: 'in_progress', metadata: active.metadata } });
    try {
      let content = options.mimo_speak_text; let calls = [];
      if (typeof content !== 'string') {
        // MiMo documents only tool_choice=auto; none is ignored upstream.
        // Omit the directory for result/permission speech and reject anomalous calls locally.
        // https://mimo.mi.com/docs/en-US/api/chat
        const tools = options.tool_choice === 'none' ? [] : (this.settings.tools || []).filter(tool => tool.type === 'function' && typeof tool.name === 'string').map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description || '', parameters: tool.parameters || { type: 'object', properties: {} } } }));
        const instructions = [this.settings.instructions || '', options.instructions || ''].filter(Boolean).join('\n');
        const vendor = miMoChatOptions(this.config);
        const reply = await this.jsonRequest(this.config.apiBaseUrl, this.config.apiKey, '/chat/completions', { model: this.config.chatModel, messages: [{ role: 'system', content: instructions }, ...this.history], ...(tools.length ? { tools, tool_choice: options.tool_choice || 'auto', parallel_tool_calls: false } : {}), ...(Object.keys(vendor).length ? vendor : { max_tokens: 1200 }), stream: false }, active.controller);
        if (!current()) return;
        const message = reply.choices?.[0]?.message;
        if (!message || ['length', 'content_filter'].includes(reply.choices?.[0]?.finish_reason)) throw new Error('对话结果不完整。');
        content = typeof message.content === 'string' ? message.content : '';
        calls = message.tool_calls || [];
        if (!Array.isArray(calls) || calls.length > 16) throw new Error('模型工具调用数量不正确。');
        if (options.tool_choice === 'none' && calls.length) throw new Error('这次结果或确认播报禁止调用工具。');
        if (userInput && this.pendingFeishuInput === userInput && tools.some(tool => tool.function.name === 'feishu_submit')) {
          if (!calls.length) {
            // Submit only the complete real user objective to the existing Gateway
            // Task/typed planner. It still owns authorization and the one-use UI gate.
            calls = [{ id: id('call'), type: 'function', function: { name: 'feishu_submit', arguments: JSON.stringify({ objective: userInput.objective }) } }];
            content = '';
          }
          if (calls.some(call => call.function?.name === 'feishu_submit')) this.pendingFeishuInput = null;
        }
        for (const call of calls) {
          if (!tools.some(tool => tool.function.name === call.function?.name) || typeof call.function.arguments !== 'string' || call.function.arguments.length > 20000) throw new Error('模型返回未知工具或过长参数。');
          try { JSON.parse(call.function.arguments); } catch { throw new Error('模型工具参数不是 JSON。'); }
          call.id ||= id('call'); this.calls.add(call.id);
          if (typeof call.id !== 'string' || call.id.length > 128 || this.calls.size > 32) throw new Error('工具回执标识或待回执数量超过上限。');
        }
        const reasoning = message.reasoning_content;
        if (reasoning != null && (typeof reasoning !== 'string' || reasoning.length > 64000)) throw new Error('模型工具上下文超过上限。');
        this.append({ role: 'assistant', content: content || null, ...(calls.length ? { tool_calls: calls, ...(typeof reasoning === 'string' ? { reasoning_content: reasoning } : {}) } : {}) });
      }
      if (!current()) return;
      const output = [];
      for (const call of calls) {
        const item = { id: id('item'), type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments, status: 'completed' };
        output.push(item); this.emit({ ...item, type: 'response.function_call_arguments.done', response_id: active.id });
      }
      if (content?.trim()) {
        if (content.length > 16000) throw new Error('对话文本过长。');
        const itemId = id('item');
        this.emit({ type: 'response.text.delta', response_id: active.id, item_id: itemId, output_index: 0, content_index: 0, delta: content });
        this.emit({ type: 'response.text.done', response_id: active.id, item_id: itemId, output_index: 0, content_index: 0, text: content });
        if (!calls.length && this.config.ttsBaseUrl && this.config.ttsApiKey && this.config.ttsModel && (options.modalities || this.settings.modalities || ['text', 'audio']).includes('audio')) {
          this.emit({ type: 'response.audio_transcript.delta', response_id: active.id, item_id: itemId, content_index: 0, delta: content });
          let speechComplete = false;
          try { await this.speak(content, active, itemId, current); speechComplete = true; }
          catch (error) { if (current()) this.emit({ type: 'mimo.speech_unavailable', message: redact(this.config, error.message), response_id: active.id }); }
          if (!current()) return;
          if (speechComplete) this.emit({ type: 'response.audio_transcript.done', response_id: active.id, item_id: itemId, content_index: 0, transcript: content });
        }
        output.push({ id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'text', text: content }] });
      }
      if (current()) this.emit({ type: 'response.done', response: { id: active.id, status: 'completed', output, metadata: active.metadata } });
    } catch (error) {
      if (current()) { this.error(error.message); this.emit({ type: 'response.done', response: { id: active.id, status: 'failed', output: [], metadata: active.metadata, status_details: { error: { message: redact(this.config, error.message) } } } }); }
    } finally { if (this.active === active) this.active = null; }
  }
  async speak(text, active, itemId, current) {
    const pieces = miMoSpeechSegments(text);
    // The text limit bounds the number of requests. PCM memory/time bounds are
    // per small segment, so a complete response may legitimately exceed 60s.
    let total = 0, segmentBytes = 0, nextAudioAt = 0, remainder = Buffer.alloc(0);
    const deliver = async bytes => {
      if (remainder.length) bytes = Buffer.concat([remainder, bytes]);
      remainder = bytes.length % 2 ? bytes.subarray(bytes.length - 1) : Buffer.alloc(0);
      bytes = bytes.subarray(0, bytes.length - remainder.length);
      if (segmentBytes + bytes.length > MIMO_TTS_SEGMENT_AUDIO_BYTES) throw new Error('单段语音超过 60 秒的安全上限。');
      for (let offset = 0; offset < bytes.length; offset += 960) {
        if (!current()) return;
        if (this.paced) { const wait = nextAudioAt - this.audioClock(); if (wait > 0) await this.audioSleep(wait, undefined, { signal: active.controller.signal }); }
        if (!current()) return;
        const chunk = bytes.subarray(offset, offset + 960); total += chunk.length; segmentBytes += chunk.length;
        // Reset after an upstream gap: never burst old deadlines to catch up.
        nextAudioAt = this.audioClock() + chunk.length / 48;
        this.emit({ type: 'response.audio.delta', response_id: active.id, item_id: itemId, output_index: 0, content_index: 0, delta: chunk.toString('base64') });
      }
    };
    let segment = 0;
    try {
      for (const piece of pieces) {
        if (!current()) return;
        if (!piece.trim()) continue;
        segment++; segmentBytes = 0; remainder = Buffer.alloc(0);
        const response = await this.upstream(this.config.ttsBaseUrl, this.config.ttsApiKey, '/chat/completions', { model: this.config.ttsModel, messages: [{ role: 'assistant', content: piece }], audio: { format: 'pcm16', voice: this.settings.voice || this.config.ttsVoice || 'mimo_default' }, stream: true }, active.controller);
        if (!current()) return;
        if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
          for await (const frame of parseMiMoSse(response.body)) {
            if (!current()) return;
            if (frame.error) throw new Error(frame.error.message || '语音合成失败。');
            const encoded = frame.choices?.[0]?.delta?.audio?.data || frame.choices?.[0]?.message?.audio?.data;
            if (encoded) await deliver(decodeBase64Audio(encoded));
          }
        } else {
          const result = JSON.parse((await responseBytes(response, 8 * 1024 * 1024)).toString('utf8'));
          await deliver(decodeBase64Audio(result.choices?.[0]?.message?.audio?.data));
        }
        if (remainder.length) throw new Error('流式 PCM 包含不完整采样。');
        if (!segmentBytes) throw new Error('这段语音合成没有返回音频。');
      }
      if (!total) throw new Error('语音合成没有返回音频。');
    } catch (error) {
      throw new Error(`语音播报在第 ${segment || 1} 段中断：${error.message}`);
    } finally {
      // One response remains one playback sequence across all segments. Close
      // any emitted partial PCM on failure; cancellation owns its own lifecycle.
      if (current() && total) this.emit({ type: 'response.audio.done', response_id: active.id, item_id: itemId, content_index: 0 });
    }
  }
  close() { this.cancelResponse(); this.resetAudio(); this.closed = true; this.history = []; this.calls.clear(); }
}

export function createMiMoRealtimeBridge({ config, WebSocketServer, bridgeToken, onInputRejected = () => {}, fetcher = fetch, host = '127.0.0.1', port = 0, paced = true } = {}) {
  if (!WebSocketServer || !bridgeToken || bridgeToken.length < 32 || !['127.0.0.1', '::1'].includes(host)) throw new Error('本机 MiMo 适配器需要 WebSocketServer、独立令牌和 loopback 地址。');
  const sessions = new Set();
  const server = http.createServer((request, response) => { response.writeHead(404); response.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    const actual = Buffer.from(String(request.headers.authorization || '')), expected = Buffer.from(`Bearer ${bridgeToken}`);
    if (request.url !== '/realtime' || request.headers.origin || actual.length !== expected.length || !timingSafeEqual(actual, expected) || sessions.size >= 4) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client));
  });
  wss.on('connection', socket => {
    let windowAt = Date.now(), audioPackets = 0, audioBytes = 0, controlPackets = 0, wireBytes = 0;
    const rejectInput = reason => {
      onInputRejected({ reason, audioPackets, audioBytes, controlPackets, wireBytes });
      socket.close(1008, reason);
    };
    const session = new MiMoBridgeSession({ config, fetcher, paced, send: event => {
      if (socket.readyState !== 1) return;
      if (socket.bufferedAmount > 2 * 1024 * 1024) { socket.close(1013, 'output queue exceeded'); return; }
      socket.send(JSON.stringify(event));
    } });
    session.sessionId = id('session'); sessions.add(session);
    socket.on('message', bytes => {
      if (socket.readyState !== 1) return;
      if (Date.now() - windowAt >= 1000) { windowAt = Date.now(); audioPackets = 0; audioBytes = 0; controlPackets = 0; wireBytes = 0; }
      wireBytes += bytes.length;
      if (wireBytes > MAX_WIRE_BYTES_PER_SECOND) { rejectInput('input byte rate exceeded'); return; }
      let message;
      try { message = JSON.parse(bytes.toString('utf8')); }
      catch (error) {
        if (++controlPackets > MAX_CONTROL_PACKETS_PER_SECOND) rejectInput('input rate exceeded');
        else session.error(error.message);
        return;
      }
      try {
        if (message?.type === 'input_audio_buffer.append') {
          audioPackets++;
          // Conservative decoded size accounting avoids a second PCM allocation.
          if (typeof message.audio === 'string') audioBytes += Math.ceil(message.audio.length / 4) * 3;
          if (audioPackets > MAX_AUDIO_PACKETS_PER_SECOND || audioBytes > MAX_AUDIO_BYTES_PER_SECOND) { rejectInput('audio input rate exceeded'); return; }
        } else if (++controlPackets > MAX_CONTROL_PACKETS_PER_SECOND) { rejectInput('input rate exceeded'); return; }
        session.receive(message);
      } catch (error) { session.error(error.message); }
    });
    socket.on('close', () => { session.close(); sessions.delete(session); });
    socket.on('error', () => { session.close(); sessions.delete(session); });
    session.emit({ type: 'session.created', session: { id: session.sessionId, model: config.chatModel } });
  });
  return {
    server,
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address()); }); }),
    close: async () => { for (const session of sessions) session.close(); for (const socket of wss.clients) socket.terminate(); await new Promise(resolve => wss.close(resolve)); if (server.listening) await new Promise(resolve => server.close(resolve)); },
  };
}
