export const MIMO_TTS_SEGMENT_CHARS = 110;
export const MIMO_TTS_SEGMENT_AUDIO_BYTES = 24000 * 2 * 60;

// Preserve every code point. Prefer complete sentences, then clauses/words,
// and only split an overlong sentence at the bounded request limit.
export function miMoSpeechSegments(text, limit = MIMO_TTS_SEGMENT_CHARS) {
  if (typeof text !== 'string') throw new TypeError('播报内容必须是文字。');
  if (!Number.isInteger(limit) || limit < 1 || limit > MIMO_TTS_SEGMENT_CHARS) throw new RangeError('播报分段大小无效。');
  const chars = Array.from(text), pieces = [];
  const minimum = Math.min(24, limit);
  for (let start = 0; start < chars.length;) {
    let end = Math.min(start + limit, chars.length);
    if (end < chars.length) {
      let sentence = 0, clause = 0;
      for (let index = start + minimum - 1; index < end; index++) {
        const char = chars[index];
        if (/[。！？!?；;\n]/u.test(char) || (char === '.' && /[\s”’」』）)\]}]/u.test(chars[index + 1] || ''))) {
          let boundary = index + 1;
          while (boundary < end && /[”’」』）)\]}]/u.test(chars[boundary])) boundary++;
          sentence = boundary;
        } else if (/[，,、：:\s]/u.test(char)) clause = index + 1;
      }
      end = sentence || clause || end;
    }
    pieces.push(chars.slice(start, end).join(''));
    start = end;
  }
  return pieces;
}
