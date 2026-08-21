"""Speechless 的本地 CosyVoice 3 推理服务。

官方 FastAPI 示例会把参考音频预先转换成 Tensor，但 CosyVoice 3 前端需要文件路径；
本适配器保留临时 WAV 路径，并在流式响应结束后立即删除。
"""
import argparse
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import uvicorn
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import StreamingResponse

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=50000)
parser.add_argument("--model-dir", required=True)
parser.add_argument("--cosyvoice-dir", required=True)
args = parser.parse_args()

root = Path(args.cosyvoice_dir).resolve()
sys.path.insert(0, str(root))
sys.path.insert(0, str(root / "third_party" / "Matcha-TTS"))
from cosyvoice.cli.cosyvoice import AutoModel  # noqa: E402

model = AutoModel(model_dir=args.model_dir)
app = FastAPI(title="Speechless CosyVoice Adapter")

@app.get("/health")
def health():
    return {"status": "ok", "sampleRate": model.sample_rate}

@app.get("/docs-ready")
def docs_ready():
    return {"status": "ok"}

@app.post("/inference_zero_shot")
async def inference_zero_shot(
    tts_text: str = Form(),
    prompt_text: str = Form(),
    prompt_wav: UploadFile = File(),
):
    descriptor, path = tempfile.mkstemp(prefix="speechless-reference-", suffix=".wav")
    try:
        with os.fdopen(descriptor, "wb") as target:
            while chunk := await prompt_wav.read(1024 * 1024):
                target.write(chunk)
    except Exception:
        os.unlink(path)
        raise

    def generate():
        try:
            outputs = model.inference_zero_shot(tts_text, prompt_text, path, stream=True)
            for output in outputs:
                samples = output["tts_speech"].detach().cpu().numpy()
                yield (samples * (2 ** 15)).clip(-32768, 32767).astype(np.int16).tobytes()
        finally:
            Path(path).unlink(missing_ok=True)

    return StreamingResponse(
        generate(),
        media_type="application/octet-stream",
        headers={"X-Sample-Rate": str(model.sample_rate)},
    )

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=args.port)
