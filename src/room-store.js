import { randomBytes, randomUUID } from 'node:crypto';

export const ROLES = Object.freeze({ TYPIST: 'typist', LISTENER: 'listener' });
const VALID_ROLES = new Set(Object.values(ROLES));

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class RoomStore {
  constructor({ reservationMs = 5 * 60_000, roomTtlMs = 30 * 60_000, maxListeners = 20, now = Date.now } = {}) {
    this.rooms = new Map();
    this.reservationMs = reservationMs;
    this.roomTtlMs = roomTtlMs;
    this.maxListeners = maxListeners;
    this.now = now;
  }

  create(creatorRole) {
    if (!VALID_ROLES.has(creatorRole)) throw new RoomError('INVALID_ROLE', '请选择有效角色');
    const id = randomBytes(16).toString('base64url');
    const token = randomBytes(24).toString('base64url');
    const room = {
      id,
      creatorRole,
      createdAt: this.now(),
      lastEmptyAt: this.now(),
      typist: null,
      listeners: new Map(),
      speech: { mode: 'device', clonedVoice: null },
      synthesisChain: Promise.resolve(),
      rateEvents: [],
      messagePlayback: new Map(),
    };
    const slot = this.#newSlot(token, null, this.now());
    if (creatorRole === ROLES.TYPIST) room.typist = slot;
    else room.listeners.set(token, slot);
    this.rooms.set(id, room);
    return { id, token, role: creatorRole };
  }

  describe(id) {
    const room = this.#getActive(id);
    return {
      id: room.id,
      availableRole: this.#availableRole(room),
      full: Boolean(room.typist) && room.listeners.size >= this.maxListeners,
      listenerCount: room.listeners.size,
      maxListeners: this.maxListeners,
    };
  }

  join({ roomId, token, name, socketId }) {
    const room = this.#getActive(roomId);
    const normalizedName = String(name ?? '').trim().slice(0, 40);
    if (!normalizedName) throw new RoomError('INVALID_NAME', '请输入显示名称');

    let role;
    let slot;
    if (room.typist?.token === token) {
      role = ROLES.TYPIST;
      slot = room.typist;
    } else if (token && room.listeners.has(token)) {
      role = ROLES.LISTENER;
      slot = room.listeners.get(token);
    }

    if (!slot) {
      if (token) throw new RoomError('SESSION_EXPIRED', '重连凭证已失效，请重新填写名称');
      role = this.#availableRole(room);
      if (!role) throw new RoomError('ROOM_FULL', `房间的听语音端已达到 ${this.maxListeners} 人`);
      token = randomBytes(24).toString('base64url');
      slot = this.#newSlot(token, normalizedName);
      if (role === ROLES.TYPIST) room.typist = slot;
      else room.listeners.set(token, slot);
    }

    if (slot.socketId && slot.socketId !== socketId) throw new RoomError('ROLE_IN_USE', '该身份正在另一台设备上使用');
    slot.name = normalizedName;
    slot.socketId = socketId;
    slot.disconnectedAt = null;
    room.lastEmptyAt = null;
    return { room, role, token };
  }

  disconnect(socketId) {
    for (const room of this.rooms.values()) {
      if (room.typist?.socketId === socketId) {
        this.#markDisconnected(room.typist);
        if (!this.isAnyoneOnline(room)) room.lastEmptyAt = this.now();
        return { room, role: ROLES.TYPIST };
      }
      for (const slot of room.listeners.values()) {
        if (slot.socketId === socketId) {
          this.#markDisconnected(slot);
          slot.listener = this.#listenerState();
          if (!this.isAnyoneOnline(room)) room.lastEmptyAt = this.now();
          return { room, role: ROLES.LISTENER };
        }
      }
    }
    return null;
  }

  roomForSocket(socketId) {
    for (const room of this.rooms.values()) {
      if (room.typist?.socketId === socketId) return { room, role: ROLES.TYPIST, slot: room.typist };
      for (const slot of room.listeners.values()) {
        if (slot.socketId === socketId) return { room, role: ROLES.LISTENER, slot };
      }
    }
    throw new RoomError('NOT_JOINED', '尚未加入房间');
  }

  setListenerState(socketId, state) {
    const { room, role, slot } = this.roomForSocket(socketId);
    if (role !== ROLES.LISTENER) throw new RoomError('FORBIDDEN', '只有听语音端可以更新语音状态');
    slot.listener = {
      ready: Boolean(state.ready),
      status: String(state.status ?? '未启用').slice(0, 20),
      voices: Array.isArray(state.voices) ? state.voices.slice(0, 200).map((voice) => ({
        name: String(voice.name ?? '').slice(0, 100),
        lang: String(voice.lang ?? '').slice(0, 20),
        voiceURI: String(voice.voiceURI ?? '').slice(0, 200),
      })) : [],
    };
    return room;
  }

  setClonedVoice(roomId, token, profile) {
    const room = this.#getActive(roomId);
    if (!room.typist || room.typist.token !== token) throw new RoomError('FORBIDDEN', '只有打字端可以创建克隆音色');
    room.speech.clonedVoice = {
      id: randomUUID(),
      name: String(profile.name ?? '').trim().slice(0, 40) || '我的克隆音色',
      promptText: String(profile.promptText ?? '').trim().slice(0, 500),
      promptWav: profile.promptWav,
    };
    if (!room.speech.clonedVoice.promptText) throw new RoomError('INVALID_PROMPT', '请输入参考录音对应的文字');
    room.speech.mode = 'cloned';
    return room.speech.clonedVoice;
  }

  setSpeechMode(socketId, mode) {
    const { room, role } = this.roomForSocket(socketId);
    if (role !== ROLES.TYPIST) throw new RoomError('FORBIDDEN', '只有打字端可以选择朗读方式');
    if (mode === 'cloned' && !room.speech.clonedVoice) throw new RoomError('VOICE_REQUIRED', '请先录制参考声音');
    room.speech.mode = mode === 'cloned' ? 'cloned' : 'device';
    return room;
  }

  validateMessage(socketId, text) {
    const { room, role } = this.roomForSocket(socketId);
    if (role !== ROLES.TYPIST) throw new RoomError('FORBIDDEN', '只有打字端可以发送消息');
    const normalized = String(text ?? '').trim();
    if (!normalized) throw new RoomError('EMPTY_MESSAGE', '消息不能为空');
    if ([...normalized].length > 500) throw new RoomError('MESSAGE_TOO_LONG', '消息不能超过 500 个字符');
    const onlineListeners = this.#onlineListeners(room);
    if (!onlineListeners.length) throw new RoomError('PEER_OFFLINE', '当前没有听语音端在线');
    if (!onlineListeners.some((slot) => slot.listener.ready)) throw new RoomError('LISTENER_NOT_READY', '听语音端尚未准备好自动朗读');

    const now = this.now();
    room.rateEvents = room.rateEvents.filter((time) => now - time < 1000);
    if (room.rateEvents.length >= 2) throw new RoomError('RATE_LIMITED', '发送太快，请稍后再试');
    room.rateEvents.push(now);
    const message = { id: randomUUID(), text: normalized, sentAt: new Date(now).toISOString(), status: '已送达' };
    room.messagePlayback.set(message.id, {
      expected: new Set(onlineListeners.filter((slot) => slot.listener.ready).map((slot) => slot.socketId)),
      played: new Set(),
    });
    return { room, message };
  }

  updatePlayback(socketId, messageId, status) {
    const { room, role } = this.roomForSocket(socketId);
    if (role !== ROLES.LISTENER) throw new RoomError('FORBIDDEN', '只有听语音端可以更新播放状态');
    const playback = room.messagePlayback.get(messageId);
    if (!playback || !playback.expected.has(socketId)) return { room, status };
    if (status === '已播放') playback.played.add(socketId);
    if (status === '播放失败') playback.expected.delete(socketId);
    if (status === '已播放' && playback.played.size < playback.expected.size) {
      return { room, status: `${playback.played.size}/${playback.expected.size} 已播放` };
    }
    if (playback.played.size >= playback.expected.size || !playback.expected.size) room.messagePlayback.delete(messageId);
    return { room, status };
  }

  presence(room) {
    const onlineListeners = this.#onlineListeners(room);
    const aggregate = this.#aggregateListenerState(onlineListeners);
    const names = onlineListeners.map((slot) => slot.name).filter(Boolean);
    return {
      typistOnline: Boolean(room.typist?.socketId),
      listenerOnline: onlineListeners.length > 0,
      typistName: room.typist?.name ?? null,
      listenerName: names[0] ?? null,
      listenerNames: names,
      listenerCount: onlineListeners.length,
      maxListeners: this.maxListeners,
      listener: aggregate,
      speech: {
        mode: room.speech.mode,
        clonedVoice: room.speech.clonedVoice ? { id: room.speech.clonedVoice.id, name: room.speech.clonedVoice.name } : null,
      },
    };
  }

  isAnyoneOnline(room) {
    return Boolean(room.typist?.socketId) || this.#onlineListeners(room).length > 0;
  }

  sweep() {
    const now = this.now();
    for (const [id, room] of this.rooms) {
      if (this.#expired(room.typist, now)) room.typist = null;
      for (const [token, slot] of room.listeners) {
        if (this.#expired(slot, now)) room.listeners.delete(token);
      }
      if (!this.isAnyoneOnline(room) && room.lastEmptyAt !== null && now - room.lastEmptyAt >= this.roomTtlMs) this.rooms.delete(id);
    }
  }

  #availableRole(room) {
    if (!room.typist) return ROLES.TYPIST;
    if (room.listeners.size < this.maxListeners) return ROLES.LISTENER;
    return null;
  }

  #onlineListeners(room) {
    return [...room.listeners.values()].filter((slot) => slot.socketId);
  }

  #aggregateListenerState(listeners) {
    const ready = listeners.some((slot) => slot.listener.ready);
    const statuses = listeners.map((slot) => slot.listener.status);
    const status = statuses.includes('播放中') ? '播放中'
      : statuses.includes('已暂停') ? '已暂停'
        : ready ? `已就绪 · ${listeners.length} 人在线` : `${listeners.length} 人在线`;
    const voices = [];
    const seen = new Set();
    for (const slot of listeners) {
      for (const voice of slot.listener.voices) {
        const key = `${voice.voiceURI}\0${voice.lang}\0${voice.name}`;
        if (!seen.has(key)) { seen.add(key); voices.push(voice); }
      }
    }
    return { ready, status, voices };
  }

  #newSlot(token, name, disconnectedAt = null) {
    return { token, name, socketId: null, disconnectedAt, listener: this.#listenerState() };
  }

  #listenerState() {
    return { ready: false, voices: [], status: '未启用' };
  }

  #markDisconnected(slot) {
    slot.socketId = null;
    slot.disconnectedAt = this.now();
  }

  #expired(slot, now) {
    return Boolean(slot && !slot.socketId && slot.disconnectedAt !== null && now - slot.disconnectedAt >= this.reservationMs);
  }

  #getActive(id) {
    this.sweep();
    const room = this.rooms.get(id);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', '房间不存在或已失效');
    return room;
  }
}
