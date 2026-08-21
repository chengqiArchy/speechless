const DEFAULT_SAMPLE_RATE = 24_000;

export class CosyVoiceClient {
  constructor({
    baseUrl = process.env.COSYVOICE_URL,
    sampleRate = DEFAULT_SAMPLE_RATE,
    promptPrefix = 'You are a helpful assistant.<|endofprompt|>',
    fetchImpl = fetch,
  } = {}) {
    this.baseUrl = baseUrl?.replace(/\/$/, '') || null;
    this.sampleRate = sampleRate;
    this.promptPrefix = promptPrefix;
    this.fetch = fetchImpl;
  }

  get configured() { return Boolean(this.baseUrl); }

  async available() {
    if (!this.configured) return false;
    try {
      const response = await this.fetch(`${this.baseUrl}/docs`, { signal: AbortSignal.timeout(2000) });
      return response.ok;
    } catch { return false; }
  }

  async synthesize({ text, promptText, promptWav }) {
    if (!this.configured) throw new Error('本地 CosyVoice 服务未配置');
    const form = new FormData();
    form.set('tts_text', text);
    form.set('prompt_text', `${this.promptPrefix}${promptText}`);
    form.set('prompt_wav', new Blob([promptWav], { type: 'audio/wav' }), 'reference.wav');
    const response = await this.fetch(`${this.baseUrl}/inference_zero_shot`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`CosyVoice 生成失败（HTTP ${response.status}）`);
    const pcm = Buffer.from(await response.arrayBuffer());
    if (!pcm.length) throw new Error('CosyVoice 返回了空音频');
    return pcm16ToWav(pcm, this.sampleRate);
  }
}

export function pcm16ToWav(pcm, sampleRate = DEFAULT_SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
