import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAudioConstraints, encodePcm16Wav, hasAudibleSignal, mergeSamples, resampleLinear } from '../public/audio-recorder.js';

test('按用户选择请求指定麦克风', () => {
  assert.deepEqual(buildAudioConstraints('mic-2').deviceId, { exact: 'mic-2' });
  assert.equal('deviceId' in buildAudioConstraints(), false);
});

test('把网页录制的浮点采样编码成 24 kHz 单声道 WAV', () => {
  const wav = Buffer.from(encodePcm16Wav(new Float32Array([-1, 0, 1]), 24_000));
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.readUInt32LE(40), 6);
});

test('拒绝没有录下声音的静音数据', () => {
  assert.equal(hasAudibleSignal(new Float32Array(24_000)), false);
  const audible = new Float32Array(24_000);
  for (let index = 0; index < audible.length; index += 1) audible[index] = Math.sin(index / 10) * 0.05;
  assert.equal(hasAudibleSignal(audible), true);
});

test('合并录音片段并重采样', () => {
  const merged = mergeSamples([new Float32Array([0, 1]), new Float32Array([2, 3])]);
  assert.deepEqual([...merged], [0, 1, 2, 3]);
  const resampled = resampleLinear(merged, 4, 2);
  assert.deepEqual([...resampled], [0, 2]);
});
