# Speechless

异地多人实时文字转语音会话 MVP。打字端发送文字，听语音端可通过浏览器内置的 Web Speech API，或本机部署的 CosyVoice 零样本克隆音色朗读。

## 运行

```bash
npm install
npm start
```

默认监听 `0.0.0.0:30293`，可通过 `PORT` 修改。

## 算法与数据流

1. 服务端为每个临时房间维护一个打字端槽位和最多 20 个听语音端槽位。
2. Socket.IO 实时转发在线状态、可用音色、消息、合成音频和播放回执。
3. 设备音色由听语音端使用 Web Speech API 朗读；克隆音色由服务端按顺序调用 CosyVoice，再将 WAV 音频发送给听语音端。
4. 参考录音、音色特征、名称和消息正文均不持久化。断线令牌仅用于 5 分钟内恢复角色，空房 30 分钟后销毁。

## 验证

```bash
npm test
npm run check
```

生产环境应在反向代理后启用 HTTPS，Socket.IO 会自动使用 WSS。

## 本地克隆音色

服务端通过 `COSYVOICE_URL` 连接 CosyVoice 官方 FastAPI 服务：

```bash
COSYVOICE_URL=http://127.0.0.1:50000 npm start
```

当前部署使用官方 `Fun-CosyVoice3-0.5B-2512` 模型。`services/cosyvoice_server.py` 提供适配 CosyVoice 3 的本地 FastAPI 服务；模型返回 24 kHz、单声道、16-bit PCM，Speechless 会将其封装为浏览器可播放的 WAV。

打字端可以直接在网页中录制一段参考声音，并填写其准确文本。浏览器将录音重采样为 24 kHz 单声道 PCM 并编码成 WAV；参考录音只保存在当前房间内存中，房间销毁后随之删除。必须获得声音所有者的明确授权。

状态检查：

```bash
curl http://127.0.0.1:30293/api/tts/status
```

