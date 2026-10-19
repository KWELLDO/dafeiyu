# 第三方组件

本仓库只包含大肥鱼自己的代码。以下是运行时会用到、由 `install.sh` 另行获取的第三方资产:

| 组件 | 用途 | 许可 | 获取方式 |
|---|---|---|---|
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | 本地推理运行时 | Apache-2.0 | pip |
| [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) | 语音识别模型 | FunASR Model License(上游未采用 Apache-2.0) | 运行时下载 |
| [Silero VAD](https://github.com/snakers4/silero-vad) | 人声检测 | MIT | 运行时下载 |

模型权重不随仓库分发。分发模型请自行核对上游许可条款。
