import { WavRecorder } from './audio-recorder.js';
import { beginRecording } from './recording-flow.js';
import { watchAvailableVoices } from './voice-loader.js';

const $ = (selector) => document.querySelector(selector);
const state = {
  roomId: location.pathname.startsWith('/room/') ? location.pathname.split('/')[2] : null,
  socket: null, role: null, token: null, name: null, presence: null,
  messages: new Map(), voices: [], ready: false, queue: [], current: null,
  speechSettings: { voiceURI: '', rate: 1, mode: 'device' },
  clonedVoice: null, currentAudio: null,
  recorder: null, recordingBlob: null, recordingUrl: null, recordingTimer: null, recordingStartedAt: null,
  recordingDetectedSound: false, noInputTimer: null,
  listenerVolume: readStoredVolume(),
  stopVoiceWatcher: null, wakeLock: null,
};
const roleLabel = (role) => role === 'typist' ? '打字端' : '听语音端';
const storageKey = () => `speechless:room:${state.roomId}`;

if (state.roomId) initializeRoom(); else show('#home-view');

$('#create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  const data = new FormData(event.currentTarget);
  const name = String(data.get('name') ?? '').trim();
  $('#create-error').textContent = '';
  if (!name) { $('#create-error').textContent = '请输入显示名称'; return; }
  submit.disabled = true;
  try {
    const response = await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: data.get('role') }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    localStorage.setItem(`speechless:room:${result.id}`, JSON.stringify({ token: result.token, name }));
    location.assign(`/room/${result.id}`);
  } catch (error) {
    $('#create-error').textContent = error.message || '创建失败，请重试';
    submit.disabled = false;
  }
});

$('#join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  state.name = new FormData(event.currentTarget).get('name').trim();
  if (!state.name) return;
  connect();
});

async function initializeRoom() {
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(state.roomId)}`);
    const room = await response.json();
    if (!response.ok) throw new Error(room.error);
    const saved = readSession();
    if (saved?.token && saved?.name) {
      state.token = saved.token;
      state.name = saved.name;
      show('#session-view');
      connect();
    } else {
      $('#join-role-hint').textContent = room.availableRole ? `你将作为${roleLabel(room.availableRole)}加入` : '这个房间当前已满';
      $('#join-form button').disabled = room.full;
      show('#join-view');
    }
  } catch (error) {
    show('#join-view');
    $('#join-role-hint').textContent = '';
    $('#join-error').textContent = error.message || '房间不存在或已经失效';
    $('#join-form button').disabled = true;
  }
}

function connect() {
  show('#session-view');
  if (state.socket) state.socket.disconnect();
  state.socket = io({ reconnectionDelay: 500, reconnectionDelayMax: 3000, timeout: 5000 });
  registerSocketEvents();
}

function registerSocketEvents() {
  const socket = state.socket;
  socket.on('connect', () => {
    updateConnection('连接中', false);
    socket.emit('room:join', { roomId: state.roomId, token: state.token, name: state.name }, (result) => {
      if (!result?.ok) {
        updateConnection('连接失败', false);
        if (result?.code === 'SESSION_EXPIRED') {
          localStorage.removeItem(storageKey());
          state.token = null;
          socket.disconnect();
          $('#join-role-hint').textContent = result.error;
          show('#join-view');
        } else toast(result?.error || '无法加入房间');
        return;
      }
      state.role = result.role;
      state.token = result.token;
      localStorage.setItem(storageKey(), JSON.stringify({ token: state.token, name: state.name }));
      setupRoleView();
      renderPresence(result.presence);
      if (state.role === 'listener' && state.ready) publishListenerState('已就绪');
      updateConnection('已连接', true);
      announce(`已作为${roleLabel(state.role)}加入房间`);
    });
  });
  socket.on('disconnect', () => {
    updateConnection('正在重连', false);
    updateComposer();
  });
  socket.on('connect_error', () => updateConnection('连接异常', false));
  socket.on('room:presence', renderPresence);
  socket.on('message:new', receiveMessage);
  socket.on('message:status', updateMessageStatus);
  socket.on('message:fallback', ({ id }) => {
    const message = state.messages.get(id);
    if (state.role === 'listener' && message) enqueueSpeech({ ...message, speechMode: 'device' });
  });
  socket.on('audio:new', ({ id, audio }) => {
    const message = state.messages.get(id);
    if (state.role === 'listener' && message) enqueueSpeech({ ...message, audio });
  });
  socket.on('voice:settings', (settings) => { state.speechSettings = settings; });
  socket.on('voice:preview', previewOnListener);
}

function setupRoleView() {
  $('#session-title').textContent = `${state.name} · ${roleLabel(state.role)}`;
  $('#voice-settings').hidden = state.role !== 'typist';
  $('#listener-controls').hidden = state.role !== 'listener';
  $('#message-form').hidden = state.role !== 'typist';
  if (state.role === 'typist') { initializeClonedVoice(); initializeMicrophones(); }
  if (state.role === 'listener') {
    startAutomaticSpeech();
    const percentage = Math.round(state.listenerVolume * 100);
    $('#volume-slider').value = String(percentage);
    $('#volume-value').textContent = `${percentage}%`;
  }
}

function renderPresence(presence) {
  if (!presence) return;
  state.presence = presence;
  $('#typist-name').textContent = presence.typistName || '打字端';
  const listenerCount = presence.listenerCount || 0;
  $('#listener-name').textContent = listenerCount > 1 ? `${presence.listenerName} 等 ${listenerCount} 人` : (presence.listenerName || '听语音端');
  $('#listener-name').title = (presence.listenerNames || []).join('、');
  $('#typist-status').textContent = presence.typistOnline ? '在线' : '等待加入 / 已断线';
  $('#listener-status').textContent = presence.listenerOnline ? presence.listener.status : '等待加入 / 已断线';
  if (state.role === 'typist') {
    state.clonedVoice = presence.speech?.clonedVoice ?? state.clonedVoice;
    $('#speech-mode').value = presence.speech?.mode === 'cloned' ? 'cloned' : 'device';
    renderVoiceMode();
    renderVoiceOptions(presence.listener.voices || []);
  }
  updateComposer();
}

function updateComposer() {
  if (state.role !== 'typist') return;
  const peerOnline = Boolean(state.presence?.listenerOnline);
  const listenerReady = Boolean(state.presence?.listener?.ready);
  const connected = state.socket?.connected;
  const input = $('#message-input');
  const button = $('#send-message');
  input.disabled = !connected || !peerOnline || !listenerReady;
  button.disabled = input.disabled || !input.value.trim();
  $('#send-hint').textContent = !connected ? '连接异常，正在尝试重连' : !peerOnline ? '等待至少一名听语音端加入' : !listenerReady ? '对方尚未启用自动朗读' : 'Enter 发送，Shift + Enter 换行';
}

$('#message-input').addEventListener('input', () => {
  $('#character-count').textContent = `${[...$('#message-input').value].length} / 500`;
  updateComposer();
});
$('#message-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#message-form').requestSubmit(); }
});
$('#message-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('#message-input');
  const text = input.value.trim();
  if (!text || input.disabled) return;
  $('#send-message').disabled = true;
  $('#send-hint').textContent = '发送中…';
  state.socket.emit('message:create', { text }, (result) => {
    if (!result?.ok) toast(result?.error || '发送失败');
    else { input.value = ''; $('#character-count').textContent = '0 / 500'; input.focus(); }
    updateComposer();
  });
});

function receiveMessage(message) {
  if (state.messages.has(message.id)) return;
  state.messages.set(message.id, message);
  $('#empty-state').hidden = true;
  const item = document.createElement('li');
  item.className = 'message';
  item.dataset.id = message.id;
  const text = document.createElement('p');
  text.textContent = message.text;
  const footer = document.createElement('footer');
  const time = document.createElement('time');
  time.dateTime = message.sentAt;
  time.textContent = new Date(message.sentAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const status = document.createElement('span');
  status.className = 'message-status';
  status.textContent = message.status;
  footer.append(time, status);
  if (state.role === 'listener') {
    const replay = document.createElement('button');
    replay.type = 'button'; replay.className = 'replay'; replay.textContent = '重播';
    replay.addEventListener('click', () => enqueueSpeech(message));
    footer.append(replay);
  }
  item.append(text, footer);
  $('#message-list').append(item);
  item.scrollIntoView({ behavior: 'smooth', block: 'end' });
  if (state.role === 'listener' && message.speechMode !== 'cloned') enqueueSpeech(message);
}

function updateMessageStatus(update) {
  const message = state.messages.get(update.id);
  if (message) message.status = update.status;
  const element = document.querySelector(`[data-id="${CSS.escape(update.id)}"] .message-status`);
  if (element) element.textContent = update.status;
}

function loadVoices() {
  if (!('speechSynthesis' in window)) {
    $('#listener-status').textContent = '此浏览器不支持朗读';
    return false;
  }
  state.stopVoiceWatcher?.();
  state.stopVoiceWatcher = watchAvailableVoices(speechSynthesis, (voices) => {
    state.voices = voices;
    if (state.role === 'listener' && state.ready) publishListenerState('已就绪');
  });
  return true;
}

async function startAutomaticSpeech() {
  if (!loadVoices()) {
    setSpeechReady(false, '播放失败');
    return;
  }
  setSpeechReady(true, '已就绪');
  speechSynthesis.resume();
  try { if ('wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* unsupported or denied */ }
}

function setSpeechReady(ready, status) {
  state.ready = ready;
  $('#pause-speech').disabled = !ready;
  $('#skip-speech').disabled = !ready;
  publishListenerState(status);
}

function publishListenerState(status) {
  if (!state.socket?.connected || state.role !== 'listener') return;
  state.socket.emit('listener:state', {
    ready: state.ready, status,
    voices: state.voices.length
      ? state.voices.map(({ name, lang, voiceURI }) => ({ name, lang, voiceURI }))
      : [{ name: '设备默认音色', lang: 'zh-CN', voiceURI: '' }],
  });
}

function renderVoiceOptions(voices) {
  const select = $('#voice-select');
  const oldValue = select.value;
  select.replaceChildren();
  if (!voices.length) {
    select.add(new Option('等待对方提供音色…', ''));
    select.disabled = true;
    $('#preview-voice').disabled = true;
    return;
  }
  select.disabled = false; $('#preview-voice').disabled = false;
  const sorted = [...voices].sort((a, b) => (a.lang.startsWith('zh') ? -1 : 1) - (b.lang.startsWith('zh') ? -1 : 1));
  sorted.forEach((voice) => select.add(new Option(`${voice.name} · ${voice.lang}`, voice.voiceURI)));
  select.value = sorted.some((voice) => voice.voiceURI === oldValue) ? oldValue : (sorted.find((voice) => voice.lang.startsWith('zh'))?.voiceURI || sorted[0].voiceURI);
  sendVoiceSettings();
}

$('#voice-select').addEventListener('change', sendVoiceSettings);
$('#rate-select').addEventListener('change', sendVoiceSettings);
$('#speech-mode').addEventListener('change', () => {
  renderVoiceMode();
  if ($('#speech-mode').value !== 'cloned' || state.clonedVoice) sendVoiceSettings();
});
function sendVoiceSettings() {
  if (!state.socket?.connected || state.role !== 'typist') return;
  state.socket.emit('voice:settings', {
    voiceURI: $('#voice-select').value,
    rate: Number($('#rate-select').value),
    mode: $('#speech-mode').value,
  }, (result) => { if (!result?.ok) toast(result?.error); });
}

async function initializeClonedVoice() {
  const option = $('#speech-mode option[value="cloned"]');
  try {
    const status = await fetch('/api/tts/status').then((response) => response.json());
    option.disabled = !status.available;
    option.textContent = status.available ? '本地克隆音色 · CosyVoice' : '本地克隆音色（模型服务未运行）';
  } catch {
    option.disabled = true;
    option.textContent = '本地克隆音色（模型服务不可用）';
  }
  renderVoiceMode();
}

function renderVoiceMode() {
  const cloned = $('#speech-mode').value === 'cloned';
  $('#device-voice-settings').hidden = cloned;
  $('#clone-voice-form').hidden = !cloned;
  if (cloned && state.clonedVoice) $('#clone-status').textContent = `当前音色：${state.clonedVoice.name}`;
}

$('#start-recording').addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    $('#recording-status').textContent = '此浏览器不支持网页录音';
    return;
  }
  let permissionTimer;
  try {
    state.recordingDetectedSound = false;
    state.recorder = new WavRecorder({
      deviceId: $('#microphone-select').value,
      onLevel: updateRecordingLevel,
      onWaveform: drawWaveform,
    });
    await beginRecording(state.recorder, {
      onRequesting: () => {
        $('#start-recording').disabled = true;
        $('#stop-recording').disabled = true;
        $('#recording-status').textContent = '正在请求麦克风权限，请留意浏览器提示…';
        permissionTimer = setTimeout(() => {
          $('#recording-status').textContent = '仍在等待麦克风权限。请点击地址栏旁的锁形图标，确认允许使用麦克风。';
        }, 6000);
      },
      onStarted: () => {
        state.recordingStartedAt = Date.now();
        state.recordingBlob = null;
        $('#stop-recording').disabled = false;
        $('#recording-preview').hidden = true;
        $('#recording-status').textContent = `正在使用“${state.recorder.activeDeviceLabel}”录音，请清晰朗读…`;
        initializeMicrophones();
        state.noInputTimer = setTimeout(() => {
          if (!state.recordingDetectedSound) $('#recording-status').textContent = '未检测到麦克风输入。请停止录音，并从上方选择其他麦克风。';
        }, 3000);
        updateRecordingClock();
        state.recordingTimer = setInterval(updateRecordingClock, 250);
      },
    });
  } catch (error) {
    state.recorder = null;
    $('#start-recording').disabled = false;
    $('#stop-recording').disabled = true;
    $('#recording-status').textContent = error.name === 'NotAllowedError'
      ? '麦克风权限被拒绝。请点击地址栏旁的锁形图标，将麦克风改为“允许”后重试。'
      : error.name === 'OverconstrainedError'
        ? '所选麦克风不可用，请选择其他输入设备'
        : (error.message || '无法启动麦克风，请重试');
  } finally { clearTimeout(permissionTimer); }
});

$('#stop-recording').addEventListener('click', stopRecording);
async function stopRecording() {
  if (!state.recorder) return;
  clearInterval(state.recordingTimer);
  clearTimeout(state.noInputTimer);
  const duration = (Date.now() - state.recordingStartedAt) / 1000;
  const recorder = state.recorder;
  state.recorder = null;
  $('#start-recording').disabled = false;
  $('#stop-recording').disabled = true;
  try {
    const blob = await recorder.stop();
    if (duration < 2 || blob.size <= 44) throw new Error('录音至少需要 2 秒');
    state.recordingBlob = blob;
    if (state.recordingUrl) URL.revokeObjectURL(state.recordingUrl);
    state.recordingUrl = URL.createObjectURL(blob);
    $('#recording-preview').src = state.recordingUrl;
    $('#recording-preview').hidden = false;
    $('#recording-status').textContent = `录音完成（${duration.toFixed(1)} 秒），可以试听或重新录制`;
  } catch (error) {
    state.recordingBlob = null;
    $('#recording-status').textContent = error.message || '录音处理失败';
  }
}

function updateRecordingClock() {
  const elapsed = Math.min(30, (Date.now() - state.recordingStartedAt) / 1000);
  $('#recording-time').textContent = `00:${String(Math.floor(elapsed)).padStart(2, '0')}`;
  if (elapsed >= 30) stopRecording();
}

function updateRecordingLevel(level) {
  if (level >= 0.02) {
    state.recordingDetectedSound = true;
    clearTimeout(state.noInputTimer);
  }
  const percentage = Math.round(level * 100);
  $('#recording-level').style.width = `${percentage}%`;
  $('.level-meter').setAttribute('aria-valuenow', String(percentage));
}

async function initializeMicrophones() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
    const select = $('#microphone-select');
    const selected = select.value;
    select.replaceChildren(new Option('系统默认麦克风', ''));
    devices.forEach((device, index) => select.add(new Option(device.label || `麦克风 ${index + 1}`, device.deviceId)));
    if ([...select.options].some((option) => option.value === selected)) select.value = selected;
  } catch { /* 权限授予前部分浏览器不允许枚举设备 */ }
}

navigator.mediaDevices?.addEventListener?.('devicechange', initializeMicrophones);

function drawWaveform(samples) {
  const canvas = $('#recording-waveform');
  const context = canvas.getContext('2d');
  const { width, height } = canvas;
  context.fillStyle = '#17221d';
  context.fillRect(0, 0, width, height);
  context.strokeStyle = '#77d7a9';
  context.lineWidth = 2;
  context.beginPath();
  const step = width / Math.max(1, samples.length - 1);
  for (let index = 0; index < samples.length; index += 1) {
    const x = index * step;
    const amplified = Math.max(-1, Math.min(1, samples[index] * 5));
    const y = height / 2 + amplified * height * 0.44;
    if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
  }
  context.stroke();
}

drawWaveform(new Float32Array(128));

$('#clone-voice-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  if (!state.recordingBlob) {
    $('#clone-status').textContent = '请先在网页中录制参考声音';
    return;
  }
  const data = new FormData(form);
  data.set('promptWav', state.recordingBlob, 'reference.wav');
  button.disabled = true;
  $('#clone-status').textContent = '正在上传参考录音…';
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(state.roomId)}/cloned-voice`, {
      method: 'POST', headers: { authorization: `Bearer ${state.token}` }, body: data,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    state.clonedVoice = result.profile;
    $('#clone-status').textContent = `当前音色：${result.profile.name}`;
    $('#speech-mode').value = 'cloned';
    sendVoiceSettings();
    toast('克隆音色已创建，仅保存在当前房间内');
  } catch (error) {
    $('#clone-status').textContent = error.message || '创建失败';
  } finally { button.disabled = false; }
});

$('#preview-voice').addEventListener('click', () => {
  state.socket.emit('voice:preview', { voiceURI: $('#voice-select').value, rate: Number($('#rate-select').value) }, (result) => toast(result?.ok ? '已在对方设备试听' : result?.error));
});

function enqueueSpeech(message) {
  if (!state.ready) { updateMessageStatus({ id: message.id, status: '播放失败' }); return; }
  state.queue.push(message);
  if (!state.current) speakNext();
}

function speakNext() {
  if (!state.ready || state.current || !state.queue.length) {
    if (!state.current && !state.queue.length && state.ready) publishListenerState('已就绪');
    return;
  }
  const message = state.queue.shift();
  state.current = message;
  if (message.audio) return playClonedAudio(message);
  const utterance = createUtterance(message.text, state.speechSettings);
  let finished = false;
  const finish = (status) => {
    if (finished) return;
    finished = true;
    state.socket.emit('message:status', { id: message.id, status });
    state.current = null;
    setTimeout(speakNext, 0);
  };
  utterance.onstart = () => { state.socket.emit('message:status', { id: message.id, status: '播放中' }); publishListenerState('播放中'); };
  utterance.onend = () => finish('已播放');
  utterance.onerror = (event) => finish(event.error === 'canceled' || event.error === 'interrupted' ? '已播放' : '播放失败');
  speechSynthesis.speak(utterance);
}

function playClonedAudio(message) {
  const url = URL.createObjectURL(new Blob([message.audio], { type: 'audio/wav' }));
  const audio = new Audio(url);
  state.currentAudio = audio;
  audio.volume = state.listenerVolume;
  let finished = false;
  const finish = (status) => {
    if (finished) return;
    finished = true;
    URL.revokeObjectURL(url);
    state.socket.emit('message:status', { id: message.id, status });
    state.currentAudio = null;
    state.current = null;
    setTimeout(speakNext, 0);
  };
  audio.addEventListener('play', () => {
    state.socket.emit('message:status', { id: message.id, status: '播放中' });
    publishListenerState('播放中');
  }, { once: true });
  audio.addEventListener('ended', () => finish('已播放'), { once: true });
  audio.addEventListener('error', () => finish('播放失败'), { once: true });
  audio.play().catch(() => finish('播放失败'));
}

function createUtterance(text, settings) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.volume = state.listenerVolume;
  const voice = state.voices.find((item) => item.voiceURI === settings.voiceURI) || state.voices.find((item) => item.lang.startsWith('zh'));
  if (voice) { utterance.voice = voice; utterance.lang = voice.lang; } else utterance.lang = 'zh-CN';
  utterance.rate = settings.rate || 1;
  return utterance;
}

$('#volume-slider').addEventListener('input', (event) => {
  const percentage = Number(event.currentTarget.value);
  state.listenerVolume = percentage / 100;
  if (state.currentAudio) state.currentAudio.volume = state.listenerVolume;
  $('#volume-value').textContent = `${percentage}%`;
  localStorage.setItem('speechless:volume', String(state.listenerVolume));
});
$('#volume-slider').addEventListener('change', () => announce(`朗读音量已调整为 ${$('#volume-slider').value}%`));

$('#pause-speech').addEventListener('click', () => {
  if (state.currentAudio) {
    if (state.currentAudio.paused) { state.currentAudio.play(); $('#pause-speech').textContent = '暂停'; }
    else { state.currentAudio.pause(); $('#pause-speech').textContent = '继续'; }
    return;
  }
  if (speechSynthesis.paused) {
    speechSynthesis.resume(); $('#pause-speech').textContent = '暂停';
    if (state.current) state.socket.emit('message:status', { id: state.current.id, status: '播放中' });
  } else if (speechSynthesis.speaking) {
    speechSynthesis.pause(); $('#pause-speech').textContent = '继续';
    if (state.current) state.socket.emit('message:status', { id: state.current.id, status: '已暂停' });
    publishListenerState('已暂停');
  }
});
$('#skip-speech').addEventListener('click', () => {
  if (state.currentAudio) { state.currentAudio.pause(); state.currentAudio.dispatchEvent(new Event('ended')); }
  else if (speechSynthesis.speaking || speechSynthesis.paused) { speechSynthesis.resume(); speechSynthesis.cancel(); }
  $('#pause-speech').textContent = '暂停';
});

function previewOnListener(settings) {
  if (!state.ready || state.current || speechSynthesis.speaking) return;
  const utterance = createUtterance('你好，这是所选音色的试听效果。', settings);
  speechSynthesis.speak(utterance);
}

$('#copy-link').addEventListener('click', async () => {
  const link = `${location.origin}/room/${state.roomId}`;
  try { await navigator.clipboard.writeText(link); toast('邀请链接已复制'); }
  catch { window.prompt('复制这个邀请链接', link); }
});

document.addEventListener('pointerdown', () => {
  if (state.role === 'listener' && 'speechSynthesis' in window) speechSynthesis.resume();
});
document.addEventListener('keydown', () => {
  if (state.role === 'listener' && 'speechSynthesis' in window) speechSynthesis.resume();
});

window.addEventListener('beforeunload', () => {
  if (state.recordingUrl) URL.revokeObjectURL(state.recordingUrl);
  state.recorder?.stream?.getTracks().forEach((track) => track.stop());
});

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.role === 'listener' && state.ready && 'wakeLock' in navigator && !state.wakeLock) {
    try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* ignored */ }
  }
});

function updateConnection(text, online) {
  $('#connection-badge').textContent = text;
  $('#connection-badge').className = `status-badge ${online ? 'online' : 'offline'}`;
}
function readSession() { try { return JSON.parse(localStorage.getItem(storageKey())); } catch { return null; } }
function readStoredVolume() {
  const value = Number(localStorage.getItem('speechless:volume') ?? 1);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}
function show(selector) { document.querySelectorAll('.view').forEach((view) => { view.hidden = true; }); $(selector).hidden = false; }
let toastTimer;
function toast(text) { if (!text) return; clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 2600); }
function announce(text) { $('#announcer').textContent = text; }
