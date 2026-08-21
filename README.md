# Speechless

异地多人实时文字转语音会话。所有成员都可以录制自己的音色并发送文字，语音会在房间所有成员端自动播放。

## 运行

```bash
npm install
npm start
```

默认监听 `0.0.0.0:30293`，可通过 `PORT` 修改。

## 算法与数据流

1. 服务端为每个临时房间维护最多 20 个权限相同的成员身份；至少 2 人在线后即可开始对话。
2. 每位成员独立保存自己的设备音色设置和 CosyVoice 参考录音。
3. 消息使用发送者自己的音色生成，并通过 Socket.IO 广播给包括发送者在内的所有成员。
4. 生成语音保留在房间内存中以供重播；房间销毁时与参考录音一并删除。
5. 断线令牌用于 5 分钟内恢复身份，空房 30 分钟后销毁。

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

每位成员都可以直接在网页中录制一段自己的参考声音，并填写其准确文本。浏览器将录音重采样为 24 kHz 单声道 PCM 并编码成 WAV；参考录音只保存在当前房间内存中，房间销毁后随之删除。必须获得声音所有者的明确授权。

状态检查：

```bash
curl http://127.0.0.1:30293/api/tts/status
```

