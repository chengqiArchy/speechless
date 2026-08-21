import { randomBytes, randomUUID } from 'node:crypto';

export const ROLES = Object.freeze({ PARTICIPANT: 'participant', TYPIST: 'participant', LISTENER: 'participant' });

export class RoomError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export class RoomStore {
  constructor({ reservationMs = 5 * 60_000, roomTtlMs = 30 * 60_000, minParticipants = 2, maxParticipants = 20, now = Date.now } = {}) {
    this.rooms = new Map();
    this.reservationMs = reservationMs;
    this.roomTtlMs = roomTtlMs;
    this.minParticipants = minParticipants;
    this.maxParticipants = maxParticipants;
    this.now = now;
  }

  create() {
    const id = randomBytes(16).toString('base64url');
    const token = randomBytes(24).toString('base64url');
    const room = {
      id, createdAt: this.now(), lastEmptyAt: this.now(), participants: new Map(),
      synthesisChain: Promise.resolve(), generatedAudio: new Map(), generatedAudioBytes: 0,
      messagePlayback: new Map(),
    };
    room.participants.set(token, this.#newParticipant(token, null, this.now()));
    this.rooms.set(id, room);
    return { id, token, role: ROLES.PARTICIPANT };
  }

  describe(id) {
    const room = this.#getActive(id);
    return {
      id, availableRole: room.participants.size < this.maxParticipants ? ROLES.PARTICIPANT : null,
      full: room.participants.size >= this.maxParticipants,
      participantCount: room.participants.size, maxParticipants: this.maxParticipants,
    };
  }

  join({ roomId, token, name, socketId }) {
    const room = this.#getActive(roomId);
    const normalizedName = String(name ?? '').trim().slice(0, 40);
    if (!normalizedName) throw new RoomError('INVALID_NAME', '请输入显示名称');
    let participant = token ? room.participants.get(token) : null;
    if (!participant) {
      if (token) throw new RoomError('SESSION_EXPIRED', '重连凭证已失效，请重新填写名称');
      if (room.participants.size >= this.maxParticipants) throw new RoomError('ROOM_FULL', `房间已达到 ${this.maxParticipants} 人`);
      token = randomBytes(24).toString('base64url');
      participant = this.#newParticipant(token, normalizedName);
      room.participants.set(token, participant);
    }
    if (participant.socketId && participant.socketId !== socketId) throw new RoomError('IDENTITY_IN_USE', '该身份正在另一台设备上使用');
    participant.name = normalizedName;
    participant.socketId = socketId;
    participant.disconnectedAt = null;
    room.lastEmptyAt = null;
    return { room, role: ROLES.PARTICIPANT, token, participant };
  }

  disconnect(socketId) {
    for (const room of this.rooms.values()) {
      for (const participant of room.participants.values()) {
        if (participant.socketId === socketId) {
          participant.socketId = null;
          participant.disconnectedAt = this.now();
          participant.playback = this.#playbackState();
          if (!this.isAnyoneOnline(room)) room.lastEmptyAt = this.now();
          return { room, role: ROLES.PARTICIPANT };
        }
      }
    }
    return null;
  }

  roomForSocket(socketId) {
    for (const room of this.rooms.values()) {
      for (const participant of room.participants.values()) {
        if (participant.socketId === socketId) return { room, role: ROLES.PARTICIPANT, slot: participant };
      }
    }
    throw new RoomError('NOT_JOINED', '尚未加入房间');
  }

  selfState(socketId) {
    const { slot } = this.roomForSocket(socketId);
    return { name: slot.name, mode: slot.speech.mode, clonedVoice: this.#profileMetadata(slot.clonedVoice) };
  }

  setListenerState(socketId, state) {
    const { room, slot } = this.roomForSocket(socketId);
    slot.playback = {
      ready: Boolean(state.ready), status: String(state.status ?? '未启用').slice(0, 20),
      voices: Array.isArray(state.voices) ? state.voices.slice(0, 200).map((voice) => ({
        name: String(voice.name ?? '').slice(0, 100), lang: String(voice.lang ?? '').slice(0, 20),
        voiceURI: String(voice.voiceURI ?? '').slice(0, 200),
      })) : [],
    };
    return room;
  }

  setClonedVoice(roomId, token, profile) {
    const room = this.#getActive(roomId);
    const participant = room.participants.get(token);
    if (!participant) throw new RoomError('FORBIDDEN', '无权为该房间创建音色');
    const promptText = String(profile.promptText ?? '').trim().slice(0, 500);
    if (!promptText) throw new RoomError('INVALID_PROMPT', '请输入参考录音对应的文字');
    participant.clonedVoice = {
      id: randomUUID(), name: String(profile.name ?? '').trim().slice(0, 40) || '我的克隆音色',
      promptText, promptWav: profile.promptWav,
    };
    participant.speech.mode = 'cloned';
    return participant.clonedVoice;
  }

  setSpeechMode(socketId, mode, settings = {}) {
    const { room, slot } = this.roomForSocket(socketId);
    if (mode === 'cloned' && !slot.clonedVoice) throw new RoomError('VOICE_REQUIRED', '请先录制参考声音');
    slot.speech = {
      mode: mode === 'cloned' ? 'cloned' : 'device',
      voiceURI: String(settings.voiceURI ?? slot.speech.voiceURI ?? '').slice(0, 200),
      rate: [0.8, 1, 1.25].includes(settings.rate) ? settings.rate : (slot.speech.rate ?? 1),
    };
    return room;
  }

  validateMessage(socketId, text) {
    const { room, slot } = this.roomForSocket(socketId);
    const normalized = String(text ?? '').trim();
    if (!normalized) throw new RoomError('EMPTY_MESSAGE', '消息不能为空');
    if ([...normalized].length > 500) throw new RoomError('MESSAGE_TOO_LONG', '消息不能超过 500 个字符');
    const online = this.#online(room);
    if (online.length < this.minParticipants) throw new RoomError('NOT_ENOUGH_PARTICIPANTS', `至少需要 ${this.minParticipants} 人在线才能开始对话`);
    if (!online.some((participant) => participant.socketId !== socketId && participant.playback.ready)) {
      throw new RoomError('PEER_NOT_READY', '其他成员尚未准备好自动朗读');
    }
    const now = this.now();
    slot.rateEvents = slot.rateEvents.filter((time) => now - time < 1000);
    if (slot.rateEvents.length >= 2) throw new RoomError('RATE_LIMITED', '发送太快，请稍后再试');
    slot.rateEvents.push(now);
    const message = {
      id: randomUUID(), text: normalized, senderId: slot.socketId, senderName: slot.name,
      sentAt: new Date(now).toISOString(), status: '已送达', speechMode: slot.speech.mode,
      voiceSettings: { voiceURI: slot.speech.voiceURI, rate: slot.speech.rate },
    };
    const ready = online.filter((participant) => participant.playback.ready);
    room.messagePlayback.set(message.id, { expected: new Set(ready.map((participant) => participant.socketId)), played: new Set() });
    return { room, message, clonedVoice: slot.speech.mode === 'cloned' ? slot.clonedVoice : null };
  }

  retainGeneratedAudio(room, messageId, audio, maxBytes = 100 * 1024 * 1024) {
    room.generatedAudio.set(messageId, audio); room.generatedAudioBytes += audio.length;
    while (room.generatedAudioBytes > maxBytes && room.generatedAudio.size > 1) {
      const oldest = room.generatedAudio.keys().next().value;
      room.generatedAudioBytes -= room.generatedAudio.get(oldest).length;
      room.generatedAudio.delete(oldest);
    }
  }

  getGeneratedAudio(socketId, messageId) {
    return this.roomForSocket(socketId).room.generatedAudio.get(messageId) ?? null;
  }

  updatePlayback(socketId, messageId, status) {
    const { room } = this.roomForSocket(socketId);
    const playback = room.messagePlayback.get(messageId);
    if (!playback || !playback.expected.has(socketId)) return { room, status };
    if (status === '已播放') playback.played.add(socketId);
    if (status === '播放失败') playback.expected.delete(socketId);
    if (status === '已播放' && playback.played.size < playback.expected.size) status = `${playback.played.size}/${playback.expected.size} 已播放`;
    if (playback.played.size >= playback.expected.size || !playback.expected.size) room.messagePlayback.delete(messageId);
    return { room, status };
  }

  presence(room) {
    const online = this.#online(room);
    const names = online.map((participant) => participant.name).filter(Boolean);
    const ready = online.some((participant) => participant.playback.ready);
    const voices = [];
    const seen = new Set();
    for (const participant of online) for (const voice of participant.playback.voices) {
      const key = `${voice.voiceURI}\0${voice.lang}\0${voice.name}`;
      if (!seen.has(key)) { seen.add(key); voices.push(voice); }
    }
    return {
      participantCount: online.length, readyParticipantCount: online.filter((participant) => participant.playback.ready).length,
      maxParticipants: this.maxParticipants,
      participantNames: names, participants: online.map((participant) => ({ name: participant.name, ready: participant.playback.ready })),
      listenerOnline: online.length > 1, listenerCount: online.length, listenerNames: names,
      listenerName: names[0] ?? null,
      listener: { ready, status: ready ? `已就绪 · ${online.length} 人在线` : `${online.length} 人在线`, voices },
    };
  }

  isAnyoneOnline(room) { return this.#online(room).length > 0; }

  sweep() {
    const now = this.now();
    for (const [id, room] of this.rooms) {
      for (const [token, participant] of room.participants) {
        if (!participant.socketId && participant.disconnectedAt !== null && now - participant.disconnectedAt >= this.reservationMs) {
          room.participants.delete(token);
        }
      }
      if (!this.isAnyoneOnline(room) && room.lastEmptyAt !== null && now - room.lastEmptyAt >= this.roomTtlMs) this.rooms.delete(id);
    }
  }

  #online(room) { return [...room.participants.values()].filter((participant) => participant.socketId); }
  #profileMetadata(profile) { return profile ? { id: profile.id, name: profile.name } : null; }
  #playbackState() { return { ready: false, status: '未启用', voices: [] }; }
  #newParticipant(token, name, disconnectedAt = null) {
    return { token, name, socketId: null, disconnectedAt, playback: this.#playbackState(), speech: { mode: 'device', voiceURI: '', rate: 1 }, clonedVoice: null, rateEvents: [] };
  }
  #getActive(id) {
    this.sweep(); const room = this.rooms.get(id);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', '房间不存在或已失效');
    return room;
  }
}
