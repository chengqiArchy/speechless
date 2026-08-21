import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore, RoomError, ROLES } from '../src/room-store.js';

const joinMembers = (store, count = 2) => {
  const created = store.create();
  const members = [store.join({ roomId: created.id, token: created.token, name: '成员1', socketId: 's1' })];
  for (let index = 2; index <= count; index += 1) {
    members.push(store.join({ roomId: created.id, name: `成员${index}`, socketId: `s${index}` }));
  }
  return { created, members, room: members[0].room };
};

test('所有加入者都是权限相同的房间成员', () => {
  const store = new RoomStore();
  const { members, room } = joinMembers(store, 3);
  assert.ok(members.every((member) => member.role === ROLES.PARTICIPANT));
  assert.equal(store.presence(room).participantCount, 3);
});

test('房间达到人数上限后拒绝继续加入', () => {
  const store = new RoomStore({ maxParticipants: 2 });
  const { room } = joinMembers(store, 2);
  assert.throws(() => store.join({ roomId: room.id, name: '成员3', socketId: 's3' }), /达到 2 人/);
});

test('任意成员都可以发送文字', () => {
  const store = new RoomStore();
  joinMembers(store, 2);
  store.setListenerState('s1', { ready: true, status: '已就绪', voices: [] });
  store.setListenerState('s2', { ready: true, status: '已就绪', voices: [] });
  assert.equal(store.validateMessage('s1', '成员1发送').message.senderName, '成员1');
  assert.equal(store.validateMessage('s2', '成员2发送').message.senderName, '成员2');
});

test('消息使用发送者自己的克隆音色', () => {
  const store = new RoomStore();
  const { created } = joinMembers(store, 2);
  store.setListenerState('s1', { ready: true, status: '已就绪', voices: [] });
  store.setListenerState('s2', { ready: true, status: '已就绪', voices: [] });
  const profile = store.setClonedVoice(created.id, created.token, {
    name: '我的声音', promptText: '参考文字', promptWav: Buffer.from('RIFF----WAVE'),
  });
  store.setSpeechMode('s1', 'cloned');
  const result = store.validateMessage('s1', '使用我的声音');
  assert.equal(result.message.speechMode, 'cloned');
  assert.equal(result.clonedVoice.id, profile.id);
  assert.equal(store.validateMessage('s2', '使用设备声音').message.speechMode, 'device');
});

test('至少有一名其他成员就绪后才能发送', () => {
  const store = new RoomStore();
  joinMembers(store, 2);
  store.setListenerState('s1', { ready: true, status: '已就绪', voices: [] });
  assert.throws(() => store.validateMessage('s1', '你好'), /其他成员尚未准备好/);
  store.setListenerState('s2', { ready: true, status: '已就绪', voices: [] });
  assert.doesNotThrow(() => store.validateMessage('s1', '你好'));
});

test('汇总所有成员的播放进度', () => {
  const store = new RoomStore();
  joinMembers(store, 3);
  for (let index = 1; index <= 3; index += 1) store.setListenerState(`s${index}`, { ready: true, status: '已就绪', voices: [] });
  const { message } = store.validateMessage('s1', '大家好');
  assert.equal(store.updatePlayback('s1', message.id, '已播放').status, '1/3 已播放');
  assert.equal(store.updatePlayback('s2', message.id, '已播放').status, '2/3 已播放');
  assert.equal(store.updatePlayback('s3', message.id, '已播放').status, '已播放');
});

test('生成语音保留在房间内存并可重播', () => {
  const store = new RoomStore();
  const { room } = joinMembers(store, 2);
  const audio = Buffer.from('RIFF audio');
  store.retainGeneratedAudio(room, 'message-1', audio);
  assert.equal(store.getGeneratedAudio('s2', 'message-1'), audio);
});

test('每位成员独立限流为每秒两条消息', () => {
  let now = 1000;
  const store = new RoomStore({ now: () => now });
  joinMembers(store, 2);
  store.setListenerState('s1', { ready: true, status: '已就绪', voices: [] });
  store.setListenerState('s2', { ready: true, status: '已就绪', voices: [] });
  store.validateMessage('s1', '一'); store.validateMessage('s1', '二');
  assert.throws(() => store.validateMessage('s1', '三'), (error) => error instanceof RoomError && error.code === 'RATE_LIMITED');
  assert.doesNotThrow(() => store.validateMessage('s2', '另一人的消息'));
  now += 1000;
  assert.doesNotThrow(() => store.validateMessage('s1', '四'));
});

test('断线后可凭令牌恢复身份和音色', () => {
  const store = new RoomStore();
  const { created } = joinMembers(store, 2);
  store.setClonedVoice(created.id, created.token, { name: '保留音色', promptText: '参考', promptWav: Buffer.from('wav') });
  store.disconnect('s1');
  const restored = store.join({ roomId: created.id, token: created.token, name: '成员1', socketId: 's1-new' });
  assert.equal(restored.participant.clonedVoice.name, '保留音色');
});

test('过期的重连凭证失效', () => {
  let now = 0;
  const store = new RoomStore({ reservationMs: 100, now: () => now });
  const created = store.create(); now = 101;
  assert.throws(() => store.join({ roomId: created.id, token: created.token, name: 'A', socketId: 'a' }), /凭证已失效/);
});

test('空房达到期限后销毁参考录音和生成语音', () => {
  let now = 0;
  const store = new RoomStore({ roomTtlMs: 100, now: () => now });
  const created = store.create(); now = 101;
  assert.throws(() => store.describe(created.id), /房间不存在/);
});
