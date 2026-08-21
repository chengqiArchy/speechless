import test from 'node:test';
import assert from 'node:assert/strict';
import { watchAvailableVoices } from '../public/voice-loader.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('即使浏览器没有触发 voiceschanged，也能发现延迟加载的音色', async () => {
  let voices = [];
  const listeners = new Set();
  const synthesizer = {
    getVoices: () => voices,
    addEventListener: (_event, listener) => listeners.add(listener),
    removeEventListener: (_event, listener) => listeners.delete(listener),
  };
  const observations = [];
  const stop = watchAvailableVoices(synthesizer, (available) => observations.push(available));
  setTimeout(() => { voices = [{ name: '普通话', lang: 'zh-CN', voiceURI: 'zh-test' }]; }, 10);

  await sleep(80);
  stop();

  assert.equal(observations.at(-1)?.length, 1, '音色列表应在浏览器静默完成加载后更新');
});
