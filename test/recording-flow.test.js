import test from 'node:test';
import assert from 'node:assert/strict';
import { beginRecording } from '../public/recording-flow.js';

test('点击开始后应立即显示正在请求麦克风，而不是等待权限完成', async () => {
  const events = [];
  let grantPermission;
  const recorder = { start: () => new Promise((resolve) => { grantPermission = resolve; }) };
  const operation = beginRecording(recorder, {
    onRequesting: () => events.push('requesting'),
    onStarted: () => events.push('started'),
  });

  await Promise.resolve();
  assert.deepEqual(events, ['requesting']);
  grantPermission();
  await operation;
  assert.deepEqual(events, ['requesting', 'started']);
});
