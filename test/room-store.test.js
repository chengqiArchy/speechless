import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore, RoomError, ROLES } from '../src/room-store.js';

const joinPair = (store) => {
  const created = store.create(ROLES.TYPIST);
  store.join({ roomId: created.id, token: created.token, name: 'A', socketId: 'a' });
  const guest = store.join({ roomId: created.id, name: 'B', socketId: 'b' });
  return { created, guest };
};

test('一个打字端可以同时接纳多个听语音端', () => {
  const store = new RoomStore();
  const { guest } = joinPair(store);
  const third = store.join({ roomId: guest.room.id, name: 'C', socketId: 'c' });
  assert.equal(guest.role, ROLES.LISTENER);
  assert.equal(third.role, ROLES.LISTENER);
  assert.equal(store.presence(guest.room).listenerCount, 2);
});

test('听语音端人数达到上限后拒绝继续加入', () => {
  const store = new RoomStore({ maxListeners: 2 });
  const { guest } = joinPair(store);
  store.join({ roomId: guest.room.id, name: 'C', socketId: 'c' });
  assert.throws(() => store.join({ roomId: guest.room.id, name: 'D', socketId: 'd' }), /达到 2 人/);
});

test('仅在听语音端在线且就绪时接受消息', () => {
  const store = new RoomStore();
  joinPair(store);
  assert.throws(() => store.validateMessage('a', '你好'), /尚未准备好/);
  store.setListenerState('b', { ready: true, status: '已就绪', voices: [] });
  const { message } = store.validateMessage('a', ' 你好 ');
  assert.equal(message.text, '你好');
  assert.equal(message.status, '已送达');
});

test('汇总多个听语音端的播放进度', () => {
  const store = new RoomStore();
  const { guest } = joinPair(store);
  store.join({ roomId: guest.room.id, name: 'C', socketId: 'c' });
  store.setListenerState('b', { ready: true, status: '已就绪', voices: [] });
  store.setListenerState('c', { ready: true, status: '已就绪', voices: [] });
  const { message } = store.validateMessage('a', '大家好');
  assert.equal(store.updatePlayback('b', message.id, '已播放').status, '1/2 已播放');
  assert.equal(store.updatePlayback('c', message.id, '已播放').status, '已播放');
});

test('每秒最多发送两条消息', () => {
  let now = 1000;
  const store = new RoomStore({ now: () => now });
  joinPair(store);
  store.setListenerState('b', { ready: true, status: '已就绪', voices: [] });
  store.validateMessage('a', '一');
  store.validateMessage('a', '二');
  assert.throws(() => store.validateMessage('a', '三'), (error) => error instanceof RoomError && error.code === 'RATE_LIMITED');
  now += 1000;
  assert.doesNotThrow(() => store.validateMessage('a', '四'));
});

test('断线后可凭令牌恢复原角色', () => {
  const store = new RoomStore();
  const { created } = joinPair(store);
  store.disconnect('a');
  const restored = store.join({ roomId: created.id, token: created.token, name: 'A2', socketId: 'a2' });
  assert.equal(restored.role, ROLES.TYPIST);
});

test('打字端可以创建并选择仅存在内存中的克隆音色', () => {
  const store = new RoomStore();
  const { created } = joinPair(store);
  const profile = store.setClonedVoice(created.id, created.token, {
    name: '测试音色', promptText: '这是一段参考文字', promptWav: Buffer.from('RIFF----WAVE'),
  });
  const room = store.setSpeechMode('a', 'cloned');
  assert.equal(profile.name, '测试音色');
  assert.equal(room.speech.mode, 'cloned');
  assert.deepEqual(store.presence(room).speech.clonedVoice, { id: profile.id, name: '测试音色' });
});

test('过期的重连凭证不能被当作新访客使用', () => {
  let now = 0;
  const store = new RoomStore({ reservationMs: 100, now: () => now });
  const created = store.create(ROLES.TYPIST);
  now = 101;
  assert.throws(
    () => store.join({ roomId: created.id, token: created.token, name: 'A', socketId: 'a' }),
    (error) => error instanceof RoomError && error.code === 'SESSION_EXPIRED',
  );
});

test('空房达到期限后销毁', () => {
  let now = 0;
  const store = new RoomStore({ roomTtlMs: 100, now: () => now });
  const created = store.create(ROLES.TYPIST);
  now = 101;
  assert.throws(() => store.describe(created.id), /房间不存在/);
});
