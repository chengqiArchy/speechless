export class WavRecorder {
  constructor({ targetSampleRate = 24_000, deviceId = '', onLevel = () => {}, onWaveform = () => {} } = {}) {
    this.targetSampleRate = targetSampleRate;
    this.deviceId = deviceId;
    this.onLevel = onLevel;
    this.onWaveform = onWaveform;
    this.chunks = [];
  }

  async start() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext || !window.MediaRecorder) throw new Error('此浏览器不支持音频录制');
    // 在点击事件的用户激活仍有效时创建，避免 iOS/Safari 在授权后挂起音频上下文。
    this.context = new AudioContext();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: buildAudioConstraints(this.deviceId),
        video: false,
      });
      this.activeDeviceLabel = this.stream.getAudioTracks()[0]?.label || '系统默认麦克风';
      await this.context.resume();
      this.source = this.context.createMediaStreamSource(this.stream);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.source.connect(this.analyser);
      this.#updateLevel();

      const preferredTypes = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'];
      const mimeType = preferredTypes.find((type) => MediaRecorder.isTypeSupported(type));
      this.mediaRecorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
      this.mediaRecorder.addEventListener('dataavailable', (event) => {
        if (event.data.size) this.chunks.push(event.data);
      });
      this.mediaRecorder.start(250);
    } catch (error) {
      this.stream?.getTracks().forEach((track) => track.stop());
      await this.context.close();
      this.context = null;
      throw error;
    }
  }

  async stop() {
    if (!this.context || !this.mediaRecorder) throw new Error('录音尚未开始');
    const stopped = new Promise((resolve, reject) => {
      this.mediaRecorder.addEventListener('stop', resolve, { once: true });
      this.mediaRecorder.addEventListener('error', () => reject(new Error('浏览器录音失败')), { once: true });
    });
    this.mediaRecorder.stop();
    await stopped;
    cancelAnimationFrame(this.levelFrame);
    this.source.disconnect();
    this.stream.getTracks().forEach((track) => track.stop());

    try {
      const encoded = new Blob(this.chunks, { type: this.mediaRecorder.mimeType });
      if (!encoded.size) throw new Error('没有获得录音数据');
      const audioBuffer = await this.context.decodeAudioData(await encoded.arrayBuffer());
      const samples = mixToMono(audioBuffer);
      if (!hasAudibleSignal(samples)) throw new Error('没有检测到声音，请检查麦克风后重新录制');
      const resampled = resampleLinear(samples, audioBuffer.sampleRate, this.targetSampleRate);
      return new Blob([encodePcm16Wav(resampled, this.targetSampleRate)], { type: 'audio/wav' });
    } finally {
      await this.context.close();
      this.context = null;
      this.onLevel(0);
    }
  }

  #updateLevel() {
    const samples = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    this.onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 8));
    this.onWaveform(samples);
    this.levelFrame = requestAnimationFrame(() => this.#updateLevel());
  }
}

export function buildAudioConstraints(deviceId = '') {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    channelCount: { ideal: 1 },
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: true },
  };
}

export function mixToMono(audioBuffer) {
  const result = new Float32Array(audioBuffer.length);
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const samples = audioBuffer.getChannelData(channel);
    for (let index = 0; index < result.length; index += 1) result[index] += samples[index] / audioBuffer.numberOfChannels;
  }
  return result;
}

export function hasAudibleSignal(samples, minimumRms = 0.001) {
  if (!samples.length) return false;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length) >= minimumRms;
}

export function mergeSamples(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export function resampleLinear(samples, sourceRate, targetRate) {
  if (!samples.length || sourceRate === targetRate) return samples;
  const result = new Float32Array(Math.round(samples.length * targetRate / sourceRate));
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < result.length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const fraction = position - left;
    result[index] = samples[left] * (1 - fraction) + samples[right] * fraction;
  }
  return result;
}

export function encodePcm16Wav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeText(view, 0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true);
  writeText(view, 8, 'WAVE'); writeText(view, 12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeText(view, 36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  return buffer;
}

function writeText(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
}
