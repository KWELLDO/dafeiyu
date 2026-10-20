# 大肥鱼 · dafeiyu

在 Linux + Wayland 上,按一下键说话,文字直接落到你正在打字的窗口里。全部离线。

三个模式:

| 快捷键 | 模式 | 怎么用 |
|---|---|---|
| `Alt+V` | 手动听写 | 按一下开始说,再按一下结束(停顿 0.8s 或说「结束」也会自动停) |
| `Alt+Shift+D` | 唤醒听写 | 常驻待命,说「我跟你说」或「然后」才开始录音,不用碰键盘 |
| `Alt+Shift+C` | 语音命令 | 常驻待命,说「大肥鱼 + 指令」直接操作桌面 |

识别引擎是 [SenseVoice](https://github.com/FunAudioLLM/SenseVoice)(中文/英文/粤语/日语/韩语),通过
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 在本地跑,不需要联网、不需要 API key,
音频不出本机。

> 大肥鱼脱胎于 [dsh](https://github.com/KWELLDO/dsh) —— 早期的语音输入是作为 dsh 的一个实验包做的,
> 后来拆出来独立成这个项目。**两种跑法都支持**:用自带的独立引擎(默认),或者接回 dsh 已经装好的
> 识别 worker 和模型(见「接回 dsh」)。

---

## 快速开始

```bash
git clone https://github.com/KWELLDO/dafeiyu.git
cd dafeiyu
./install.sh
```

`install.sh` 会:建 Python 虚拟环境装 `sherpa-onnx`、下载 SenseVoice int8 模型(~230MB)与
Silero VAD、把程序装到 `~/.local/share/dafeiyu`、链接到 `~/.local/bin/dafeiyu`、写好 systemd 用户单元。

然后把 [`contrib/niri.kdl`](contrib/niri.kdl) 里的三个键位粘进 `~/.config/niri/config.kdl`,
跑一次 `niri validate`,再 `niri msg action load-config-file`。

> 键位可以随便改。唤醒键默认 **Alt+Shift+D**,是因为 `Alt+Shift+V` 经常被终端里的语音插件占用;
> 全局绑定会先吃掉按键,终端收不到。想换回去就改 niri 配置里那一行。

试一句:

```bash
dafeiyu --exec "切到第二个桌面" --dry     # 只解析,不执行
dafeiyu                                   # 按下说话
```

## 依赖

| 需要 | 用途 | Arch |
|---|---|---|
| node >= 20 | 全部逻辑 | `nodejs` |
| PipeWire(`pw-record`) | 录音 | `pipewire` |
| `wtype` | 把文字打进焦点窗口 | `wtype` |
| `wl-clipboard` | 微信等 Qt 应用走粘贴 | `wl-clipboard` |
| `libnotify` | 状态提示(可选) | `libnotify` |
| Python 3.10–3.13 | 独立识别引擎 | `python` |
| `ydotool` + `ydotoold` | 语音点击(可选) | `ydotool`(需 uinput 权限) |
| niri | 桌面操作类指令 | `niri` |

只在 niri 上验证过。听写本身只依赖 `wtype` + `pw-record`,理论上任何 Wayland 合成器都能用;
命令模式里的桌面动作是 niri 专有的。

## 配置

默认值写死在 `lib/core.mjs`,想改就编辑 `~/.config/dafeiyu/config`(装完已有一份注释样例),
改完 `dafeiyu --stop-all` 再重开。

常用几项:

```ini
DAFEIYU_TYPE_DELAY=1        # 逐字上屏延时(ms),1 最快;个别应用丢字就调到 5~30
DAFEIYU_AUTO_STOP_MS=800    # 停顿多久算一句结束
DAFEIYU_WAKE_WORDS=我跟你说,你听我跟你说,然后
DAFEIYU_CMD_WAKE_WORDS=大肥鱼,大飞鱼
DAFEIYU_SEND_WORDS=回车,回车键,换行,发送        # 结尾说这些词自动回车
DAFEIYU_PASTE_APPS=wechat   # 这些应用改用剪贴板粘贴
DAFEIYU_NLU=ollama:actbro/minicpm5-2b-jev:latest
```

唤醒词可以写多个,用逗号分隔,识别结果里出现任意一个就触发,后面接的内容会一起保留
(说「然后明天下午三点见」= 直接开始听写「明天下午三点见」)。「然后」很常见,待命时正常说话
也可能误触发;嫌太灵敏就从列表里去掉,或换成「然后呢」这种更少见的说法。

所有键都能用同名环境变量覆盖,方便临时试:
`DAFEIYU_AUTO_STOP_MS=1500 dafeiyu`。

## 语音命令能做什么

规则命中走 0ms 的本地解析,没命中才交给小模型(默认本地 ollama 上的 2B 模型,约 300ms;
也可以 `off` 或 `deepseek`)。

```
切到第三个桌面          把终端挪到第二个桌面       下一个桌面
左边的窗口 / 上一个窗口   窗口往右移                 关掉这个窗口 / 全屏 / 浮动 / 居中 / 截图
在微信里输入明天下午三点见                         输入随便一句话
点 500 400             点 500 400 右键
打开浏览器 / 切到终端    音量加 / 音量减 / 静音
```

任何一句话结尾说「回车」或「发送」(容忍一字误差,「半送」也认),会先去掉这个词再敲回车。

## 接回 dsh

dsh 里已经装好的识别 worker 和模型可以直接复用,不重复下载:

```bash
DAFEIYU_STT_BACKEND=dsh dafeiyu
# 或者指到别处的 worker:
DAFEIYU_STT_BACKEND=dsh DAFEIYU_DSH_WORKER=/path/to/worker.js dafeiyu
```

此时 `stt/serve-dsh.mjs` 会以 dsh 的协议把 worker 拉起来,并把端口和一次性 token 写到
`$XDG_RUNTIME_DIR/dafeiyu/port.json` —— 协议与独立引擎完全一致(见下),所以两种后端可以随时互换。

要求 dsh 的 `speech-to-text-sensevoice` 包已构建,数据目录默认在
`~/.dsh/speech-to-text/sensevoice`(可用 `DAFEIYU_DSH_DATA` 改)。

## 协议

识别引擎是一个只监听 loopback 的 HTTP 服务,客户端从 `port.json` 读端口和 token:

```
POST http://127.0.0.1:<port>/transcribe?language=zh
authorization: Bearer <token>
content-type: audio/wav

<16kHz / 单声道 / PCM16 WAV>
→ {"text": "...", "audioSeconds": 2.31}
```

WAV 必须是规范的 44 字节头、`data` 在偏移 36、长度字等于实际字节数 —— 用 ffmpeg 生成时加
`-fflags +bitexact -map_metadata -1`,否则会多出 LIST 块被拒。

想自己接一个引擎(whisper.cpp、Vosk、云 API),照着这个协议实现一个服务、把 `port.json` 写好就行,
上层三个守护进程一行都不用改。

## 已知坑(都踩过了)

- **微信输入乱码**:Qt 客户端对虚拟键盘合成的 Unicode keysym 处理有缺陷,长串数字会变成乱码。
  解法是把该应用加进 `DAFEIYU_PASTE_APPS`,走 `wl-copy` + Ctrl+V,并恢复原剪贴板。
- **最后几个字丢**:一是录音要留 400ms 尾巴再断流,二是音频尾部补 200ms 静音,三是打完字等 250ms
  再退出 —— `wtype` 拆虚拟键盘太快会吃掉最后几个按键。
- **唤醒模式只听一次就哑**:不要在唤醒判定后对 `pw-record` 发 SIGINT,让它一直跑,断了再重连。
- **`wtype -d 0`** 是非法值(会报 Invalid sleep time),最小 1ms。
- **说一半卡一下就出现句号**:识别给段与段之间补了 `。`。现在引擎把一次听写里的段用 `，` 连起来,
  客户端再把"句号后面紧跟中文"的情况并成逗号 —— 想保留原样就把 `lib/core.mjs` 里的 `mergeBreaks` 去掉。
  另外 `DAFEIYU_AUTO_STOP_MS=800` 很灵敏,超过 0.8s 的停顿会直接结束这次录音(后面的话不再收);
  如果希望容忍更长的犹豫,把它调到 1200~1500。

## 隐私

音频只在本机内存里,识别完就丢;不发网络请求。唯一的例外是命令模式的小模型兜底 —— 默认走本机
`ollama`,如果你手动把它改成 `deepseek`,那句话的文本会发到 DeepSeek 的接口,音频仍然不发。

## 许可

大肥鱼 · 大肥鱼语音输入(dafeiyu)
Copyright (C) 2026 KWELLDO

代码:GPL-3.0-or-later,见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。

模型权重不在本仓库内,由 `install.sh` 在运行时下载,遵循各自的许可:

- SenseVoice(SenseVoiceSmall):FunASR 模型许可,见上游仓库
- Silero VAD:MIT

本项目与 FunAudioLLM、k2-fsa、dsh 上游均无从属关系。
