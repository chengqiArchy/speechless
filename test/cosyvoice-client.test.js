import test from 'node:test';
import assert from 'node:assert/strict';
import { CosyVoiceClient, pcm16ToWav } from '../src/cosyvoice-client.js';

test('把 CosyVoice 的 PCM 响应封装为浏览器可播放的 WAV', () => {
  const wav = pcm16ToWav(Buffer.from([0, 0, 1, 0]), 24_000);
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.readUInt32LE(40), 4);
});

test('使用参考录音和对应文字请求零样本克隆', async () => {
  let request;
  const client = new CosyVoiceClient({
    baseUrl: 'http://cosyvoice:50000/',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(Buffer.from([0, 0]), { status: 200 });
    },
  });
  const wav = await client.synthesize({ text: '新的句子', promptText: '参考句子', promptWav: Buffer.from('wav') });
  assert.equal(request.url, 'http://cosyvoice:50000/inference_zero_shot');
  assert.equal(request.options.body.get('tts_text'), '新的句子');
  assert.equal(request.options.body.get('prompt_text'), 'You are a helpful assistant.<|endofprompt|>参考句子');
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
});
