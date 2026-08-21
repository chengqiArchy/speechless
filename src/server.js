import http from 'node:http';
import express from 'express';
import multer from 'multer';
import { Server } from 'socket.io';
import { CosyVoiceClient } from './cosyvoice-client.js';
import { RoomError, RoomStore, ROLES } from './room-store.js';

const port = Number.parseInt(process.env.PORT ?? '30293', 10);
const host = process.env.HOST ?? '0.0.0.0';
const app = express();
const server = http.createServer(app);
const io = new Server(server, { serveClient: true, transports: ['websocket', 'polling'] });
const rooms = new RoomStore();
const cosyvoice = new CosyVoiceClient();
const uploadReference = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 3 },
});

app.disable('x-powered-by');
app.use((request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'microphone=(self), camera=()');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' ws: wss:; base-uri 'none'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: '8kb' }));
app.use(express.static('public', { extensions: ['html'] }));

app.post('/api/rooms', (request, response) => {
  try {
    const result = rooms.create(request.body?.role);
    log('room.created', { roomId: result.id, creatorRole: result.role });
    response.status(201).json(result);
  } catch (error) {
    sendError(response, error);
  }
});

app.get('/api/rooms/:id', (request, response) => {
  try {
    response.json(rooms.describe(request.params.id));
  } catch (error) {
    sendError(response, error);
  }
});

app.get('/api/tts/status', async (_request, response) => {
  response.json({ configured: cosyvoice.configured, available: await cosyvoice.available(), engine: 'Fun-CosyVoice3-0.5B' });
});

app.post('/api/rooms/:id/cloned-voice', uploadReference.single('promptWav'), (request, response) => {
  try {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!request.file || !isWav(request.file.buffer)) throw new RoomError('INVALID_AUDIO', '请上传不超过 15 MB 的 WAV 录音');
    const profile = rooms.setClonedVoice(request.params.id, token, {
      name: request.body.name,
      promptText: request.body.promptText,
      promptWav: request.file.buffer,
    });
    const room = rooms.rooms.get(request.params.id);
    io.to(request.params.id).emit('room:presence', rooms.presence(room));
    response.status(201).json({ ok: true, profile: { id: profile.id, name: profile.name } });
    log('voice_profile.created', { roomId: request.params.id, profileId: profile.id, audioBytes: request.file.size });
  } catch (error) {
    sendError(response, error);
  }
});

app.get('/health', (_request, response) => response.json({ status: 'ok' }));
app.get('/room/:id', (_request, response) => response.sendFile('index.html', { root: 'public' }));
app.use((error, _request, response, _next) => sendError(response, error));

io.on('connection', (socket) => {
  socket.on('room:join', (payload, acknowledge = () => {}) => {
    try {
      const result = rooms.join({
        roomId: payload?.roomId,
        token: payload?.token,
        name: payload?.name,
        socketId: socket.id,
      });
      socket.join(result.room.id);
      socket.data.roomId = result.room.id;
      socket.data.role = result.role;
      acknowledge({ ok: true, role: result.role, token: result.token, presence: rooms.presence(result.room) });
      io.to(result.room.id).emit('room:presence', rooms.presence(result.room));
      log('room.joined', { roomId: result.room.id, role: result.role, correlationId: socket.id });
    } catch (error) {
      acknowledge(socketError(error));
    }
  });

  socket.on('listener:state', (payload, acknowledge = () => {}) => {
    try {
      const room = rooms.setListenerState(socket.id, payload ?? {});
      io.to(room.id).emit('room:presence', rooms.presence(room));
      acknowledge({ ok: true });
    } catch (error) {
      acknowledge(socketError(error));
    }
  });

  socket.on('message:create', (payload, acknowledge = () => {}) => {
    try {
      const { room, message } = rooms.validateMessage(socket.id, payload?.text);
      message.speechMode = room.speech.mode;
      io.to(room.id).emit('message:new', message);
      acknowledge({ ok: true, id: message.id });
      log('message.delivered', { roomId: room.id, messageId: message.id, speechMode: message.speechMode, latencyMs: 0 });
      if (message.speechMode === 'cloned') {
        room.synthesisChain = room.synthesisChain
          .then(() => synthesizeClonedMessage(room, message))
          .catch(() => {});
      }
    } catch (error) {
      acknowledge(socketError(error));
    }
  });

  socket.on('message:status', (payload) => {
    try {
      const { room, role } = rooms.roomForSocket(socket.id);
      const allowed = new Set(['播放中', '已播放', '播放失败', '已暂停']);
      if (role !== ROLES.LISTENER || !allowed.has(payload?.status) || typeof payload?.id !== 'string') return;
      const id = payload.id.slice(0, 60);
      const aggregate = rooms.updatePlayback(socket.id, id, payload.status);
      io.to(room.id).emit('message:status', { id, status: aggregate.status });
    } catch { /* disconnected clients can be ignored */ }
  });

  socket.on('voice:settings', (payload, acknowledge = () => {}) => {
    try {
      const { room, role } = rooms.roomForSocket(socket.id);
      if (role !== ROLES.TYPIST) throw new RoomError('FORBIDDEN', '只有打字端可以设置音色');
      const rate = [0.8, 1, 1.25].includes(payload?.rate) ? payload.rate : 1;
      const updatedRoom = rooms.setSpeechMode(socket.id, payload?.mode);
      const settings = { voiceURI: String(payload?.voiceURI ?? '').slice(0, 200), rate, mode: updatedRoom.speech.mode };
      socket.to(room.id).emit('voice:settings', settings);
      io.to(room.id).emit('room:presence', rooms.presence(updatedRoom));
      acknowledge({ ok: true });
    } catch (error) {
      acknowledge(socketError(error));
    }
  });

  socket.on('voice:preview', (payload, acknowledge = () => {}) => {
    try {
      const { room, role } = rooms.roomForSocket(socket.id);
      if (role !== ROLES.TYPIST) throw new RoomError('FORBIDDEN', '只有打字端可以试听');
      socket.to(room.id).emit('voice:preview', {
        voiceURI: String(payload?.voiceURI ?? '').slice(0, 200),
        rate: [0.8, 1, 1.25].includes(payload?.rate) ? payload.rate : 1,
      });
      acknowledge({ ok: true });
    } catch (error) {
      acknowledge(socketError(error));
    }
  });

  socket.on('disconnect', () => {
    const result = rooms.disconnect(socket.id);
    if (!result) return;
    io.to(result.room.id).emit('room:presence', rooms.presence(result.room));
    log('room.disconnected', { roomId: result.room.id, role: result.role, correlationId: socket.id });
  });
});

setInterval(() => rooms.sweep(), 60_000).unref();

server.listen(port, host, () => log('server.started', { host, port }));

function socketError(error) {
  const known = error instanceof RoomError;
  return { ok: false, code: known ? error.code : 'INTERNAL_ERROR', error: known ? error.message : '服务暂时不可用' };
}

function sendError(response, error) {
  const result = socketError(error);
  response.status(result.code === 'ROOM_NOT_FOUND' ? 404 : 400).json(result);
}

async function synthesizeClonedMessage(room, message) {
  const profile = room.speech.clonedVoice;
  if (!profile) return io.to(room.id).emit('message:fallback', { id: message.id });
  io.to(room.id).emit('message:status', { id: message.id, status: '正在生成语音' });
  try {
    const audio = await cosyvoice.synthesize({ text: message.text, promptText: profile.promptText, promptWav: profile.promptWav });
    io.to(room.id).emit('audio:new', { id: message.id, audio });
    log('tts.generated', { roomId: room.id, messageId: message.id, audioBytes: audio.length });
  } catch (error) {
    io.to(room.id).emit('message:status', { id: message.id, status: '生成失败，使用设备音色' });
    io.to(room.id).emit('message:fallback', { id: message.id });
    log('tts.failed', { roomId: room.id, messageId: message.id, errorType: error.constructor.name });
  }
}

function isWav(buffer) {
  return buffer?.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WAVE';
}

function log(operation, fields) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), operation, ...fields }));
}
