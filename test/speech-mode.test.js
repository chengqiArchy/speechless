import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSpeechMode } from '../public/speech-mode.js';

test('配置 CosyVoice 期间不被服务器的旧设备音色状态覆盖', () => {
  assert.equal(resolveSpeechMode({
    remoteMode: 'device',
    localMode: 'cloned',
    configuringClonedVoice: true,
  }), 'cloned');
});

test('没有本地配置时采用服务器状态', () => {
  assert.equal(resolveSpeechMode({ remoteMode: 'device', localMode: 'cloned', configuringClonedVoice: false }), 'device');
  assert.equal(resolveSpeechMode({ remoteMode: 'cloned', localMode: 'device', configuringClonedVoice: false }), 'cloned');
});
