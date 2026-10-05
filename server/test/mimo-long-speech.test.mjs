import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { MiMoBridgeSession } from '../src/voice/providers/mimo-bridge.mjs';
import { miMoSpeechSegments, MIMO_TTS_SEGMENT_AUDIO_BYTES } from '../src/voice/providers/mimo-speech-segments.mjs';

const config = { apiBaseUrl: 'https://chat.invalid/v1', apiKey: 'mock-chat', chatModel: 'mock-chat',
  ttsBaseUrl: 'https://tts.invalid/v1', ttsApiKey: 'mock-tts', ttsModel: 'mock-tts', ttsVoice: 'mock-voice' };
const reply = content => Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
const frame = bytes => `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: bytes.toString('base64') } } }] })}\n\n`;
function stream(frames) {
  const iterator = frames[Symbol.asyncIterator]?.() || frames[Symbol.iterator]();
  return new Response(new ReadableStream({
    async pull(controller) {
      const value = await iterator.next();
      if (value.done) controller.close(); else controller.enqueue(Buffer.from(value.value));
    },
    async cancel() { await iterator.return?.(); },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}
function audio(bytes = Buffer.alloc(960), count = 1) {
  return stream((function* () { for (let index = 0; index < count; index++) yield frame(bytes); yield 'data: [DONE]\n\n'; })());
}
function fixture(context, fetcher, options = {}) {
  const events = [], chunks = [], texts = [], requests = [];
  const session = new MiMoBridgeSession({ config, paced: false, ...options,
    fetcher: async (url, init) => {
      const body = JSON.parse(init.body); requests.push(body);
      if (url.startsWith(config.ttsBaseUrl)) texts.push(body.messages[0].content);
      return fetcher(url, body, init);
    },
    send: event => {
      if (event.type === 'response.audio.delta') {
        const pcm = Buffer.from(event.delta, 'base64');
        chunks.push({ bytes: pcm.length, firstSample: pcm.readInt16LE(0), responseId: event.response_id,
          at: options.clock?.() || 0 });
        events.push({ ...event, delta: undefined });
      } else events.push(event);
    },
  });
  context.after(() => session.close());
  return { session, events, chunks, texts, requests };
}
async function until(check) {
  for (let attempt = 0; attempt < 300; attempt++) { if (check()) return; await delay(5); }
  throw new Error('Long speech test did not reach the expected state.');
}

test('default speech requests every character through a Unicode tail marker without summarizing', async context => {
  const text = `${'这一段说明需要完整朗读，不能省略中间的内容。🙂'.repeat(32)}最终结束标记：全部朗读完成。`;
  const f = fixture(context, async url => url.startsWith(config.ttsBaseUrl) ? audio() : reply(text));
  await f.session.respond({});
  assert.ok(Array.from(text).length > 230);
  assert.ok(f.texts.length > 3);
  assert.equal(f.texts.join(''), text);
  assert.ok(f.texts.at(-1).includes('全部朗读完成'));
  assert.ok(f.texts.every(piece => Array.from(piece).length <= 110 && piece.isWellFormed()));
  assert.equal(f.events.filter(event => event.type === 'response.audio.done').length, 1);
  assert.equal(f.events.find(event => event.type === 'response.audio_transcript.done').transcript, text);
  assert.equal(f.events.at(-1).response.status, 'completed');
  assert.ok(f.chunks.every(chunk => chunk.responseId === f.events.at(-1).response.id && chunk.bytes <= 960 && chunk.bytes % 2 === 0));
});

test('segmentation preserves all text and prefers sentence/clause boundaries over splitting short sentences', () => {
  const first = `${'甲'.repeat(60)}。`;
  const text = `${first}${'乙'.repeat(70)}，${'丙'.repeat(100)}。最后😀一句。`;
  const pieces = miMoSpeechSegments(text);
  assert.equal(pieces[0], first);
  assert.equal(pieces.join(''), text);
  assert.ok(pieces.every(piece => Array.from(piece).length <= 110 && piece.isWellFormed()));
  const longSentence = `${'😀'.repeat(230)}末尾标记`;
  assert.equal(miMoSpeechSegments(longSentence).join(''), longSentence);
  assert.ok(miMoSpeechSegments(longSentence).every(piece => piece.isWellFormed()));
});

test('a complete response streams more than 60 seconds of PCM across bounded segments and one final done', async context => {
  const text = `${'甲'.repeat(100)}。${'乙'.repeat(100)}。`;
  const f = fixture(context, async () => audio(Buffer.alloc(48000), 31));
  await f.session.respond({ mimo_speak_text: text });
  assert.equal(f.texts.join(''), text);
  assert.equal(f.texts.length, 2);
  const bytes = f.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
  assert.equal(bytes, 24000 * 2 * 62);
  assert.ok(bytes > MIMO_TTS_SEGMENT_AUDIO_BYTES);
  assert.equal(f.events.filter(event => event.type === 'response.audio.done').length, 1);
  assert.ok(!f.events.some(event => event.type === 'mimo.speech_unavailable'));
  assert.equal(f.events.at(-1).response.status, 'completed');
});

test('an upstream gap resets PCM pacing without a catch-up burst in the following segment', async context => {
  let now = 0, count = 0;
  const waits = [];
  const f = fixture(context, async () => {
    if (++count === 2) now += 5000;
    return audio(Buffer.alloc(2880));
  }, { paced: true, clock: () => now, sleep: async milliseconds => { waits.push(milliseconds); now += milliseconds; } });
  await f.session.respond({ mimo_speak_text: `${'甲'.repeat(100)}。${'乙'.repeat(100)}。` });
  assert.deepEqual(f.chunks.map(chunk => chunk.at), [0, 20, 40, 5040, 5060, 5080]);
  assert.deepEqual(waits, [20, 20, 20, 20]);
  assert.ok(f.chunks.every(chunk => chunk.bytes === 960));
});

test('a single runaway segment remains bounded, preserves text and reports incomplete speech', async context => {
  const text = '这一句也不能接受服务端无限生成音频。';
  const f = fixture(context, async () => audio(Buffer.alloc(48000), 61));
  await f.session.respond({ mimo_speak_text: text });
  assert.equal(f.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0), MIMO_TTS_SEGMENT_AUDIO_BYTES);
  assert.ok(f.events.some(event => event.type === 'mimo.speech_unavailable' && /60 秒/u.test(event.message)));
  assert.equal(f.events.filter(event => event.type === 'response.audio.done').length, 1);
  assert.ok(!f.events.some(event => event.type === 'response.audio_transcript.done'));
  assert.equal(f.events.find(event => event.type === 'response.text.done').text, text);
  assert.equal(f.events.at(-1).response.status, 'completed');
});

test('an empty later segment cannot silently skip text or report the whole narration as complete', async context => {
  const text = `${'甲'.repeat(100)}。${'乙'.repeat(100)}。`;
  let calls = 0;
  const f = fixture(context, async () => ++calls === 1 ? audio() : stream(['data: [DONE]\n\n']));
  await f.session.respond({ mimo_speak_text: text });
  assert.equal(f.events.filter(event => event.type === 'response.audio.done').length, 1);
  assert.ok(f.events.some(event => event.type === 'mimo.speech_unavailable' && /第 2 段/u.test(event.message)));
  assert.ok(!f.events.some(event => event.type === 'response.audio_transcript.done'));
  assert.equal(f.events.find(event => event.type === 'response.text.done').text, text);
});

test('an odd PCM sample at a segment boundary is rejected instead of mixed with the next segment', async context => {
  let calls = 0;
  const f = fixture(context, async () => { calls++; return audio(Buffer.alloc(961)); });
  await f.session.respond({ mimo_speak_text: `${'甲'.repeat(100)}。${'乙'.repeat(100)}。` });
  assert.equal(calls, 1);
  assert.ok(f.events.some(event => event.type === 'mimo.speech_unavailable' && /不完整采样/u.test(event.message)));
  assert.equal(f.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0), 960);
  assert.equal(f.events.filter(event => event.type === 'response.audio.done').length, 1);
  assert.ok(!f.events.some(event => event.type === 'response.audio_transcript.done'));
});

test('interrupting a later TTS segment fences late audio and never completes the cancelled narration', async context => {
  let release, calls = 0;
  const f = fixture(context, async () => ++calls === 2
    ? new Promise(resolve => { release = resolve; }) : audio());
  const first = f.session.respond({ mimo_speak_text: `${'甲'.repeat(100)}。${'乙'.repeat(100)}。` });
  await until(() => release);
  const oldId = f.events.find(event => event.type === 'response.created').response.id;
  f.session.cancelResponse();
  await f.session.respond({ mimo_speak_text: '新的简短回复。' });
  release(audio(Buffer.alloc(960, 9))); await first;
  assert.equal(f.chunks.filter(chunk => chunk.responseId === oldId).length, 1);
  assert.ok(!f.events.some(event => event.type === 'response.audio.done' && event.response_id === oldId));
  assert.ok(!f.events.some(event => event.type === 'response.audio_transcript.done' && event.response_id === oldId));
  assert.equal(f.events.find(event => event.type === 'response.done' && event.response.id === oldId).response.status, 'cancelled');
  assert.equal(f.events.filter(event => event.type === 'response.audio.done').length, 1);
});

test('oversized text remains rejected before any TTS upload instead of removing all safety bounds', async context => {
  let requests = 0;
  const f = fixture(context, async () => { requests++; return audio(); });
  await f.session.respond({ mimo_speak_text: '甲'.repeat(16001) });
  assert.equal(requests, 0);
  assert.equal(f.events.at(-1).response.status, 'failed');
});
