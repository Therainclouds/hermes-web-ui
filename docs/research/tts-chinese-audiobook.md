# 中文多角色有声书 TTS 引擎选型调研报告

> 目标场景：把一个中文小说/剧本切成**大量小片段**，旁白用一个声音、每个角色按**性别**分配不同声音，逐段合成音频后**拼接**成一整本书。
> 调研时间：2026-09-13。所有实测数据来自本机（Python 3.13 / edge-tts 7.2.8 / Node v26.5.0 / ffprobe）。
> 凡无法验证的内容一律在文中标注 **⚠️ 未能验证**，不做猜测。

---

## 0. 结论速览（TL;DR）

| 结论 | 说明 |
|---|---|
| **最快落地** | `edge-tts`（Python）——零密钥、免费、中文音色可用，但**法律风险高**且**随时可能 403/503** |
| **最稳、可商用（托管）** | Azure AI Speech 官方付费（`zh-CN-XiaomoNeural` / `zh-CN-YunyeNeural` 是唯一支持 8 种 `role` 的中文音色） |
| **最稳、可商用（自建）** | **Qwen3-TTS**（Apache-2.0 含权重、3 秒克隆、97 ms 流式、prompt 复用保证多角色一致） |
| **现成的分段→拼接工具链** | **IndexTTS-2.5** 的 `indextts2 batch --concat`（~6 GB 显存），代价是 bilibili 自定义许可 |
| **最省显存 + MIT** | **GPT-SoVITS**（4060Ti 级；参考音频须严格 3–10 秒，且要关掉有 bug 的 CUDA Graph） |
| **CPU 即可、完全合法** | **Kokoro-82M-v1.1-zh**（Apache-2.0，55 女 + 45 男固定音色，**不能克隆**） |
| **Node.js 集成** | 官方只有 `microsoft-cognitiveservices-speech-sdk`；edge-tts 侧 `msedge-tts` 可用且为 MIT |
| **关键坑 1** | edge-tts 暴露的**中文音色只有 14 个**（Azure 官方目录有 59 个），且 Edge 端点**不支持 SSML 的 `mstts:express-as`** |
| **关键坑 2** | edge-tts 每个片段带 **~100ms 起始静音**，逐段拼接必须做处理 |
| **关键坑 3** | 很多"常识"是错的：CosyVoice **仓库已迁移**、Fish Speech **已换自定义非商用许可**、Spark-TTS **权重非商用**、VibeVoice **TTS 代码已下架**、ChatTTS **不能克隆** |
| **关键坑 4** | **绝大多数开源零样本克隆模型不文档化推理显存**；"男女"是参考音频的属性，不是模型属性 |

---

## 1. edge-tts

### 1.1 包现状、版本与安装

| 包 | 生态 | 最新版本 | 许可证 | 仓库 / 说明 |
|---|---|---|---|---|
| `edge-tts` | Python (PyPI) | **7.2.8** | LGPL-3.0 | [github.com/rany2/edge-tts](https://github.com/rany2/edge-tts) · [pypi.org/project/edge-tts](https://pypi.org/project/edge-tts/) |
| `msedge-tts` | Node (npm) | **2.0.7**（2026-07-09） | **MIT** | [github.com/Migushthe2nd/MsEdgeTTS](https://github.com/Migushthe2nd/MsEdgeTTS) · [npmjs.com/package/msedge-tts](https://www.npmjs.com/package/msedge-tts) |
| `node-edge-tts` | Node (npm) | **1.2.10**（2026-02-05） | **MIT** | [github.com/SchneeHertz/node-edge-tts](https://github.com/SchneeHertz/node-edge-tts) · [npmjs.com/package/node-edge-tts](https://www.npmjs.com/package/node-edge-tts) |
| `edge-tts`（同名 npm 包） | Node (npm) | **1.0.1**（2024-04-15，已停更） | **CC BY-NC-SA 4.0**（非商用！） | ⚠️ `main` 字段指向 `index.ts`，**发布包缺 TypeScript 构建配置，实际上不可直接 `require`**；不建议使用 |
| `@andresaya/edge-tts` | Node (npm) | 1.8.0（2025-12-13） | **GPL-3.0-only** | `engines: { bun: ">=0.5.0" }`，面向 Bun 而非 Node ⚠️ 未能验证其在 Node 下的可用性 |

```bash
# Python
pip install edge-tts          # 或 pipx install edge-tts
# Node
npm install msedge-tts        # 或 npm install node-edge-tts
```

### 1.2 最小 API

**Python —— 流式（推荐，可边收边写）**

```python
import asyncio, edge_tts

async def main():
    communicate = edge_tts.Communicate(
        "这是旁白。", "zh-CN-YunxiNeural",
        rate="+0%", volume="+0%", pitch="+0Hz",
        boundary="SentenceBoundary",   # 或 "WordBoundary"
    )
    submaker = edge_tts.SubMaker()
    with open("out.mp3", "wb") as f:
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] in ("WordBoundary", "SentenceBoundary"):
                submaker.feed(chunk)      # 时间轴元数据
    open("out.srt", "w").write(submaker.get_srt())

asyncio.run(main())
```

**Python —— 一次性存文件**

```python
asyncio.run(edge_tts.Communicate("文本", "zh-CN-XiaoxiaoNeural").save("out.mp3"))
# 同步版本（内部自建事件循环）：save_sync() / stream_sync()
```

**命令行**

```bash
edge-tts --voice zh-CN-XiaoxiaoNeural --text "你好" \
         --write-media hello.mp3 --write-subtitles hello.srt
edge-tts --list-voices
```

**Node —— `msedge-tts`（流式或写文件）**

```js
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

const tts = new MsEdgeTTS();
await tts.setMetadata("zh-CN-XiaoxiaoNeural",
  OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
  { wordBoundaryEnabled: true, sentenceBoundaryEnabled: true });

// 流式
const { audioStream } = tts.toStream("你好，世界");
audioStream.on("data", (d) => process.stdout.write(d));

// 或写文件
const { audioFilePath } = await tts.toFile("./tmp", "你好，世界");
```

**Node —— `node-edge-tts`（以写文件为主）**

```js
import { EdgeTTS } from "node-edge-tts";
const tts = new EdgeTTS({
  voice: "zh-CN-XiaoyiNeural", lang: "zh-CN",
  outputFormat: "audio-24khz-48kbitrate-mono-mp3",
  rate: "+0%", pitch: "+0Hz", volume: "+0%",
  saveSubtitles: true, timeout: 10000,
});
await tts.ttsPromise("你好，世界", "./out.mp3");
```

> ⚠️ `msedge-tts` README 明确提示：**2025-12 起 Read Aloud API 要求 User-Agent 必须是 Microsoft Edge**，因此浏览器端不可用，**服务端仍可用**。
> ⚠️ `msedge-tts` 只支持 `speak` / `voice` / `prosody` 三种 SSML 元素（README 原文 ~~Full support for SSML~~）。

### 1.3 它到底怎么工作的？是否用了 Azure 公共端点而不需要密钥？

**是。** 源码（`edge_tts/constants.py`，7.2.8）写得很清楚：

```python
BASE_URL = "speech.platform.bing.com/consumer/speech/synthesize/readaloud"
TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"
WSS_URL = f"wss://{BASE_URL}/edge/v1?TrustedClientToken={TRUSTED_CLIENT_TOKEN}"
VOICE_LIST = f"https://{BASE_URL}/voices/list?trustedclienttoken={TRUSTED_CLIENT_TOKEN}"
```

- 用的是微软 **Edge 浏览器"朗读"（Read Aloud）** 的消费者端点，**内嵌一个硬编码的公开 `TrustedClientToken`**，不是 Azure Speech 密钥。
- 伪装成 Edge 浏览器：`User-Agent: ... Edg/143.0.3650.75`、WebSocket `Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold`（Edge 朗读扩展的 ID）。
- 为了通过微软的反滥用校验，库里有专门的 `drm.py`，生成 `Sec-MS-GEC` / `Sec-MS-GEC-Version` 令牌（基于 Windows FILETIME 时钟、每 5 分钟取整、SHA-256，见 [issue #290](https://github.com/rany2/edge-tts/issues/290) 的评论），并做**时钟偏移校正**。

**稳定性风险（有历史证据，不是猜测）：**

| 时间 | 事件 | 证据 |
|---|---|---|
| 2024-10 | 微软上线 `Sec-MS-GEC` 校验，全球大规模 403 | [issue #265](https://github.com/rany2/edge-tts/issues/265)、[#286](https://github.com/rany2/edge-tts/issues/286)、[#290](https://github.com/rany2/edge-tts/issues/290)（**177 条评论**）、[#293](https://github.com/rany2/edge-tts/issues/293) |
| 2025-08 | 再次大面积 403 持续 40+ 小时（Edge 版本号从 UA/Sec-MS-GEC-Version 对不上） | [issue #401](https://github.com/rany2/edge-tts/issues/401)（32 条评论） |
| 2026-01 | 又一轮 403 | [issue #458](https://github.com/rany2/edge-tts/issues/458) |
| 2026-07 | 503 `Invalid response status` | [issue #482](https://github.com/rany2/edge-tts/issues/482) |
| 2026-07 | 部分语言（亚美尼亚语/旁遮普语/巴斯克语）持续 `NoAudioReceived`，即**单点音色被悄悄下线** | [issue #481](https://github.com/rany2/edge-tts/issues/481) |

**结论：微软确实多次限流/封锁过 edge-tts。** 每次封锁后靠社区逆向修补（`Sec-MS-GEC`、UA 版本号 `CHROMIUM_FULL_VERSION`）恢复，**恢复周期数天到数周**。这类修补要求**持续跟进上游版本**；用旧版本会直接不可用。

**条款 / 法律风险：**

- edge-tts 走的不是 Azure 订阅，**微软官方明确表态**（Microsoft Q&A 官方 Staff Moderator 回答）："如果这些仓库依赖微软的专有服务……**在没有有效 Azure 订阅的情况下商用可能违反我们的服务条款**"，并建议"要合法提供 TTS 服务，请使用微软官方的 Azure AI Speech"。
  来源：[Are Opensource Edge-TTS free for commercial use? — Microsoft Q&A](https://learn.microsoft.com/en-my/answers/questions/2088770/are-opensource-edge-tts-free-for-commercial-use)
- 另有一条微软官方 Q&A 讨论：[Unofficial Edge TTS API](https://learn.microsoft.com/en-au/answers/questions/2392491/unofficial-edge-tts-api)。
- ⚠️ **未能验证**：微软是否已经**实际**对某个 edge-tts 使用方发起过法律行动；检索到的只有服务层面的技术封锁。
- ⚠️ **未能验证**：具体的每日/每 IP 请求配额数字。实测中**没有**遇到显式 rate-limit 头。

**实践建议**：仅用于**原型 / 个人内部用途**；商用请换 Azure 官方或自建模型。

### 1.4 Edge 端点实际暴露的 zh-* 音色全表（**实测**）

以下是我在本机运行 `edge-tts --list-voices` 从**活的 Edge 端点**拉到的全部中文音色（共 **14 个**），Gender 与 persona 均为服务端返回值：

| ShortName | Gender | ContentCategories | VoicePersonalities |
|---|---|---|---|
| `zh-CN-XiaoxiaoNeural` | Female | News, Novel | Warm |
| `zh-CN-XiaoyiNeural` | Female | Cartoon, Novel | Lively |
| `zh-CN-YunjianNeural` | Male | Sports, Novel | Passion |
| `zh-CN-YunxiNeural` | Male | Novel | Lively, Sunshine |
| `zh-CN-YunxiaNeural` | Male | Cartoon, Novel | Cute |
| `zh-CN-YunyangNeural` | Male | News | Professional, Reliable |
| `zh-CN-liaoning-XiaobeiNeural` | Female | Dialect | Humorous |
| `zh-CN-shaanxi-XiaoniNeural` | Female | Dialect | Bright |
| `zh-HK-HiuGaaiNeural` | Female | General | Friendly, Positive |
| `zh-HK-HiuMaanNeural` | Female | General | Friendly, Positive |
| `zh-HK-WanLungNeural` | Male | General | Friendly, Positive |
| `zh-TW-HsiaoChenNeural` | Female | General | Friendly, Positive |
| `zh-TW-HsiaoYuNeural` | Female | General | Friendly, Positive |
| `zh-TW-YunJheNeural` | Male | General | Friendly, Positive |

**给"按性别选角色音"的可选池（旁白 + 角色）：**

- 女声 5 个（普通话 4 + 东北 1 + 陕西 1，实际 6 个女声）
- 男声 4 个（Xiaoxiao 系列除外）：`YunjianNeural`（激情/体育）、`YunxiNeural`（活泼阳光少年感）、`YunxiaNeural`（可爱卡通，适合小男孩/萌系）、`YunyangNeural`（专业可靠，最适合**旁白**）
- 粤语 3 个、台湾国语 3 个

> ⚠️ **重要**：Edge 端点**只有这 14 个**。Azure 官方目录里其它带"更好人设"的中文音色（`zh-CN-XiaomoNeural`、`zh-CN-YunyeNeural`、`zh-CN-XiaohanNeural`、`zh-CN-XiaoruiNeural`、`zh-CN-YunzeNeural`、`zh-CN-XiaochenNeural` 等）在 Edge 端点上**会返回空音频 / `NoAudioReceived`**。
> ⚠️ edge-tts 的 `TTSConfig` 只做正则校验 `^[a-z]{2,}-[A-Z]{2,}-(.+Neural)$`，**不会**报"音色不存在"，所以误用 Azure-only 音色时会静默失败。
>
> 全库规模参考：Edge 端点共 **324** 个音色 / 140 个 locale（Female 163、Male 159）。

### 1.5 `--rate` / `--pitch` / `--volume` 格式与边界

**格式（源码 `data_classes.py` 的正则，7.2.8）：**

```python
rate   : r"^[+-]\d+%$"    # 默认 "+0%"
volume : r"^[+-]\d+%$"    # 默认 "+0%"
pitch  : r"^[+-]\d+Hz$"   # 默认 "+0Hz"
```

- **必须带符号**：`+50%` ✅，`50%` ❌（`ValueError`）
- pitch **只接受 Hz，不接受 `st`（半音）或百分比**
- CLI 传负数要写成 `--rate=-50%`（否则被 argparse 当成选项）

**边界（实测，用 ffprobe 量时长）：**

| rate | 时长（同一句话） | 结论 |
|---|---|---|
| `+0%` | 6.216 s | 基准 |
| `+50%` | 4.152 s | 生效 |
| `+100%` | 3.144 s | 生效 |
| `+200%` | 3.144 s | **与 +100% 完全一致 → 被钳制在 +100%** |

| pitch | 输出 md5 | 结论 |
|---|---|---|
| `-50Hz` / `+0Hz` / `+50Hz` / `+200Hz` | 四个都不同 | ✅ 生效 |
| `+1000Hz` | 有效输出（时长不变，字节不同） | 未被拒绝 |

- **库本身不设上下界**（只校验格式）。真正生效上限由服务端决定。
- 实测：**语速上限约 `+100%`**（再大被服务端忽略）；音高在 `±50Hz..+200Hz` 范围内确实改变音频；更大值未逐一验证实际听感。
- ⚠️ **未能验证**：服务端文档化的精确上下界（微软未公开 Edge 消费者端点的 prosody 限制）。
- 参考：上游 issue [Does --rate/--volume/--pitch have bounds? (#464)](https://github.com/rany2/edge-tts/issues/464) 被维护者以 `not_planned` 关闭，未给出边界值。

### 1.6 SSML 支持情况

**edge-tts 不支持自定义 SSML。** 官方 README 原文：

> "Support for custom SSML was removed because Microsoft prevents the use of any SSML that could not be generated by Microsoft Edge itself. ... **the service only permits a single `<voice>` tag with a single `<prosody>` tag inside it.**"

实际生成的 SSML（源码 `communicate.py#mkssml`）被写死为：

```xml
<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>
  <voice name='Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoxiaoNeural)'>
    <prosody pitch='+0Hz' rate='+0%' volume='+0%'>TEXT</prosody>
  </voice>
</speak>
```

**因此 Edge 端点不支持：**

- ❌ `mstts:express-as`（**没有 style / role / styledegree**）→ **无法用 Edge 做"角色扮演"**
- ❌ 多 `<voice>` 标签（不能一段文本里切角色）
- ❌ `<break>`、`<emphasis>`、`<phoneme>`、`<say-as>`、`<sub>`、`<audio>`、`<mstts:*>`
- ❌ `<lang xml:lang>` 换语言
- ✅ 仅 `voice` + `prosody(pitch/rate/volume)`

**替代做法**：想区分角色，只能**换音色 + 调 pitch/rate**。例如把 `YunxiaNeural` 的 pitch 拉到 `+80Hz` 做成小男孩，或把 `XiaoyiNeural` 的 rate 放慢、pitch 降低做成沉稳女声。

**文本预处理（源码 `remove_incompatible_characters` + `escape`）：** 会剔除竖表符 `\x0b` 等不兼容字符，然后做 XML 转义；按 **4096 字节**上限自动分片（`split_text_by_byte_length`），且不会切断 UTF-8 多字节字符或 XML 实体。

### 1.7 词边界 / 句子边界元数据（SubMaker）

- 支持两种边界事件：**`WordBoundary`** 和 **`SentenceBoundary`**（`Communicate(..., boundary="SentenceBoundary")`，默认就是 SentenceBoundary）。
- 流式返回的 chunk 形如：
  ```python
  {"type": "WordBoundary", "offset": 1000000, "duration": 35875000, "text": "你好"}
  ```
- `offset` / `duration` 单位是 **100 纳秒 tick**（`SubMaker` 里 `timedelta(microseconds=msg["offset"] / 10)`）。
- `SubMaker.feed(chunk)` 累积 cue，`get_srt()` 输出 SRT。

**实测（`zh-CN-XiaoxiaoNeural`，WordBoundary，文本"这是第一句话。这是第二句话，用来测试并发合成的稳定性。"）：**

```
1  00:00:00,100 --> 00:00:00,262  这
2  00:00:00,262 --> 00:00:00,412  是
3  00:00:00,437 --> 00:00:00,762  第一
...
```

**注意点：**

1. **第一个 cue 从 0.100s 开始**，不是 0 → 每段音频前约 **100ms 静音**（服务端行为）。拼接时要考虑。
2. 分词结果是**子词级**（"第一"、"并发合"这种切法），做**句级**字幕请用 `SentenceBoundary`。
3. 一个 `Communicate` 内部把长文本切成多个 4096 字节片，**跨片的 offset 需要补偿**。edge-tts 7.2.x 改成了按**累计 MP3 字节数**精确推算（48 kbps CBR 是定长码率，字节→时长是精确换算，见 [issue #466](https://github.com/rany2/edge-tts/issues/466) / [constants.py 的注释](https://github.com/rany2/edge-tts/blob/main/src/edge_tts/constants.py)）。**这也意味着如果你的段落很短（一两个句子），根本不会触发分片，时间轴天然准确。**

### 1.8 输出音频格式、采样率与拼接

**实测确认（ffprobe）：**

```
codec_name=mp3  sample_rate=24000  channels=1  bit_rate=48000
format=mp3      bit_rate=48000
```

- **格式：MP3，24 kHz，单声道，48 kbps CBR**（源码里的 `"outputFormat":"audio-24khz-48kbitrate-mono-mp3"`）
- **文件头没有 ID3 / Xing 标签**，直接是 MP3 帧（首 4 字节 `ff f3 64 c4`），所以**字节级拼接技术上可行**（同参数 CBR）
- `node-edge-tts` / `msedge-tts` 可以请求别的格式（如 `audio-24khz-96kbitrate-mono-mp3`、`webm-24khz-16bit-mono-opus`），但 **Python 版写死 48 kbps mp3**

**拼接很多小片段 —— 推荐做法：**

```bash
# 方案 A（无损、最快、CBR 同参数下安全）
#   concat demuxer，不重编码
printf "file '%s'\n" seg_*.mp3 > list.txt
ffmpeg -f concat -safe 0 -i list.txt -c copy full.mp3

# 方案 B（更稳，统一重编码；顺便规整帧边界）
ffmpeg -f concat -safe 0 -i list.txt -ar 24000 -ac 1 -b:a 48k full.mp3
```

**坑：**
- 每个片段**开头约 100 ms 静音**，逐段拼接会让朗读听起来"一顿一顿"。建议对每段做**首尾静音裁剪**（`ffmpeg -af silenceremove=start_periods=1:start_threshold=-50dB`），再插入统一的句间停顿。
- 不要用 `cat a.mp3 b.mp3 > out.mp3`：能播，但没有 ID3/Xing 头，部分播放器 seek 会不准。

### 1.9 延迟与并发（**实测**）

测试文本：「这是第一句话。这是第二句话，用来测试并发合成的稳定性。」（29 字）

| 场景 | 结果 |
|---|---|
| 串行 3 次 | **1.98 s / 1.55 s / 2.91 s** |
| **并发 8 个请求** | 1.68–2.99 s（多数），**其中一个被拖到 11.58 s**；墙钟 **11.59 s** |
| 串行 10 个极短片段 | **总 21.87 s → 平均 2.19 s/片** |
| CLI 单次（含进程启动） | 2.2 s |

**结论：**

- **单个短请求 ≈ 1.5–3 s**（一次 WebSocket 握手 + 一句合成）。这基本是**固定开销**，跟文本长度关系不大。
- **并发可行但有天花板**：8 并发里 7 个照常（~2 s），1 个被服务端拖到 11.6 s。说明 Edge 端点会对突发并发做**排队/降级**。
- **对有声书的意义**：一本 10 万字小说若按 2000 字/段切 → 50 段，串行约 **110 s**；10000 字/段 → 10 段约 **22 s**。真正疼的是**按句切**（几千段 × 2.2 s = 数小时）。
- **建议并发度 4–6**，加指数退避重试 + 超时（库默认 `connect_timeout=10`、`receive_timeout=60`）。
- 上游已知额外开销：SSL context 每次连接重建（Windows 上约 250 ms），见 [issue #465](https://github.com/rany2/edge-tts/issues/465)。Linux 上影响较小。

---

## 2. Azure AI Speech（官方付费替代方案）

> 官方文档仓库抓取，另见 MicrosoftDocs/azure-ai-docs 的原始 markdown（`includes/language-support/tts.md`）。

### 2.1 zh-CN 标准神经音色（共 22 个，含 styles / roles）

| ShortName | 性别 | Styles | Roles |
|---|---|---|---|
| `zh-CN-XiaoxiaoNeural` | Female | `affectionate` `angry` `assistant` `calm` `chat` `chat-casual` `cheerful` `customerservice` `disgruntled` `excited` `fearful` `friendly` `gentle` `lyrical` `newscast` `poetry-reading` `sad` `serious` `sorry` `whispering` | ❌ |
| `zh-CN-YunxiNeural` | Male | `angry` `assistant` `chat` `cheerful` `depressed` `disgruntled` `embarrassed` `fearful` `narration-relaxed` `newscast` `sad` `serious` | ✅ `Boy` `Narrator` `YoungAdultMale` |
| `zh-CN-YunjianNeural` | Male | `angry` `cheerful` `depressed` `disgruntled` `documentary-narration` `narration-relaxed` `sad` `serious` `sports-commentary` `sports-commentary-excited` | ❌ |
| `zh-CN-XiaoyiNeural` | Female | `affectionate` `angry` `cheerful` `disgruntled` `embarrassed` `fearful` `gentle` `sad` `serious` | ❌ |
| `zh-CN-YunyangNeural` | Male | `customerservice` `narration-professional` `newscast-casual` | ❌ |
| `zh-CN-XiaochenNeural` | Female | `livecommercial` | ❌ |
| `zh-CN-XiaohanNeural` | Female | `affectionate` `angry` `calm` `cheerful` `disgruntled` `embarrassed` `fearful` `gentle` `sad` `serious` | ❌ |
| `zh-CN-XiaomengNeural` | Female | `chat` | ❌ |
| **`zh-CN-XiaomoNeural`** | Female | `affectionate` `angry` `calm` `cheerful` `depressed` `disgruntled` `embarrassed` `envious` `fearful` `gentle` `sad` `serious` | ✅ **全部 8 种**：`Boy` `Girl` `YoungAdultFemale` `YoungAdultMale` `OlderAdultFemale` `OlderAdultMale` `SeniorFemale` `SeniorMale` |
| `zh-CN-XiaoqiuNeural` | Female | — | ❌ |
| `zh-CN-XiaorouNeural` | Female | — | ❌ |
| `zh-CN-XiaoruiNeural` | Female | `angry` `calm` `fearful` `sad` | ❌ |
| `zh-CN-XiaoshuangNeural` | Female, Child | `chat` | ❌ |
| `zh-CN-XiaoxiaoDialectsNeural` | Female | — | ❌ |
| `zh-CN-XiaoyanNeural` | Female | — | ❌ |
| `zh-CN-XiaoyouNeural` | Female, Child | — | ❌ |
| `zh-CN-XiaozhenNeural` | Female | `angry` `cheerful` `disgruntled` `fearful` `sad` `serious` | ❌ |
| `zh-CN-YunfengNeural` | Male | `angry` `cheerful` `depressed` `disgruntled` `fearful` `sad` `serious` | ❌ |
| `zh-CN-YunhaoNeural` | Male | `advertisement-upbeat` | ❌ |
| `zh-CN-YunjieNeural` | Male | — | ❌ |
| `zh-CN-YunxiaNeural` | Male | `angry` `calm` `cheerful` `fearful` `sad` | ❌ |
| **`zh-CN-YunyeNeural`** | Male | `angry` `calm` `cheerful` `disgruntled` `embarrassed` `fearful` `sad` `serious` | ✅ **全部 8 种** |
| `zh-CN-YunzeNeural` | Male | `angry` `calm` `cheerful` `depressed` `disgruntled` `documentary-narration` `fearful` `sad` `serious` | ✅ `OlderAdultMale` `SeniorMale` |

**zh-CN 多语言音色（8 个）：** `zh-CN-XiaochenMultilingualNeural`(F)、`zh-CN-XiaoshuangMultilingualNeural`(F)、`zh-CN-XiaoxiaoMultilingualNeural`(F)、`zh-CN-XiaoyouMultilingualNeural`(F)、`zh-CN-XiaoyuMultilingualNeural`(F)、`zh-CN-YunfanMultilingualNeural`(M)、`zh-CN-YunxiaoMultilingualNeural`(M)、`zh-CN-YunyiMultilingualNeural`(M) —— **全部 Roles = Not supported**。

**zh-CN 方言变体（7 个）：** `zh-CN-guangxi-YunqiNeural`(M)、`zh-CN-henan-YundengNeural`(M)、`zh-CN-liaoning-XiaobeiNeural`(F)、`zh-CN-liaoning-YunbiaoNeural`(M)、`zh-CN-shaanxi-XiaoniNeural`(F)、`zh-CN-shandong-YunxiangNeural`(M)、`zh-CN-sichuan-YunxiNeural`(M)。

**zh-HK（3 个）：** `zh-HK-HiuMaanNeural`(F)、`zh-HK-WanLungNeural`(M)、`zh-HK-HiuGaaiNeural`(F)。

**zh-TW（3 个）：** `zh-TW-HsiaoChenNeural`(F)、`zh-TW-YunJheNeural`(M)、`zh-TW-HsiaoYuNeural`(F)。

**Neural HD / HD Flash / HD Omni（中文相关约 28 个，均为 `*:DragonHD*LatestNeural` 或 `*:MAI-Voice-2*`）：** 含 `zh-CN-Xiaoxiao:DragonHDFlashLatestNeural`(F)、`zh-CN-Xiaoxiao2:DragonHDFlashLatestNeural`(F)、`zh-CN-Yunxiao:DragonHDFlashLatestNeural`(M)、`zh-CN-Yunyi:DragonHDFlashLatestNeural`(M)、`zh-CN-Xiaochen:DragonHDLatestNeural`(F)、`zh-CN-Yunfan:DragonHDLatestNeural`(M)、`zh-CN-Xiaoyue`/`zh-CN-Yunqi`/`zh-CN-Maroonallegro`:DragonHDOmniLatestNeural、`zh-CN-Bo`/`Lan`/`Mei`/`Wei`:MAI-Voice-2(-Flash) 等。**全部 Roles = Not supported。** 风格名用连字符形式（`customer-service`、`voice-assistant`），与 Standard 的连写小写（`customerservice`）**不通用**。

> ⚠️ **未能验证**：`zh-CN-XiaoxuanNeural` —— 官方清单中**完全不存在**（用户清单里点名的这个音色查无此声）。
> ⚠️ **未能验证**：`zh-CN-XiaoyuNeural`（不带后缀）—— 官方只有 `zh-CN-XiaoyuMultilingualNeural` 和 `zh-CN-Xiaoyu:DragonHDFlashLatestNeural`。

**zh-CN 语音记录总数：59**（含 Standard / Multilingual / HD / MAI）。

### 2.2 SSML 与 `mstts:express-as`（style / role / styledegree）

Azure **完整支持 SSML**：`<speak>` `<voice>`（可多个）`<prosody>`（pitch/rate/volume/contour/range）`<emphasis>` `<audio>` `<break>` `<phoneme>` `<say-as>` `<sub>` `<lang xml:lang>`，以及 `mstts:` 扩展：`mstts:express-as`、`mstts:audioduration`（≤300s）、`mstts:backgroundaudio`、`mstts:viseme`、`mstts:voiceconversion`、`mstts:dialog`（multi-talker）。

| `mstts:express-as` 属性 | 说明 |
|---|---|
| `style` | 语音特定风格。缺失/非法时**整个 `mstts:express-as` 被忽略**，回落到中性。**必填** |
| `styledegree` | 风格强度，`0.01`–`2`（含），默认 `1`，步长 `0.01`。缺失或不支持则忽略 |
| `role` | 角色扮演（同一音色模仿不同年龄/性别，**音色名不变**）。缺失或不支持则忽略 |

**支持 `role` 的中文音色只有 4 个**（全为 Standard）：

- `zh-CN-XiaomoNeural`：全部 8 种
- `zh-CN-YunyeNeural`：全部 8 种
- `zh-CN-YunzeNeural`：`OlderAdultMale` `SeniorMale`
- `zh-CN-YunxiNeural`：`Boy` `Narrator` `YoungAdultMale`

**`style` 支持的粒度**：如 `zh-CN-XiaoxiaoNeural` 支持 20 种 style（`news`/`customerservice`/`poetry-reading`/`sad`/`angry`…）。完整 style 定义见官方文档。

**注意**：`emphasis`（词级重音）**只支持 `en-US-GuyNeural` / `en-US-DavisNeural` / `en-US-JaneNeural`**，中文不可用。

**中文 role-play 官方示例：**

```xml
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis"
       xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-CN">
  <voice name="zh-CN-XiaomoNeural">
    女儿看见父亲走了进来，问道：
    <mstts:express-as role="YoungAdultFemale" style="calm">
      “您来的挺快的，怎么过来的？”
    </mstts:express-as>
    父亲放下手提包，说：
    <mstts:express-as role="OlderAdultMale" style="calm">
      “刚打车过来的，路上还挺顺畅。”
    </mstts:express-as>
  </voice>
</speak>
```

> **对有声书的关键取舍**：如果想靠 `role` 做多角色，只能用那 4 个 Standard 音色；**HD 系列虽然风格多，但一律不支持 role**。反过来说，如果用**多个不同 voice**（旁白 Xiaoxiao、少年 Yunxi、大叔 Yunze、老人 role=SeniorMale…），Standard 与 HD 都能做多角色。

### 2.3 Custom Neural Voice / Personal Voice

| 对比项 | Personal Voice | Professional Voice（原 Custom Neural Voice） |
|---|---|---|
| 目标场景 | 让**最终用户**在 App 内创建自己的声音 | 品牌/角色音、有声书朗读 |
| 训练数据 | **1 分钟** | **300–2,000 条 utterance（约 30 分钟–3 小时）** |
| 训练时间 | **< 5 秒** | 约 20–40 compute hours（多风格约 90h，计费上限 96h） |
| 音质 | Natural | Highly natural |
| 多语言 | 约 100 种语言，自动语言检测 | 需选 "Neural – cross lingual" 特征 |
| 访问 | **Limited Access，需注册审批** | **Limited Access，需审批**（且通常仅限与微软有客户关系的客户） |
| 定价 | 合成 $24/1M + **profile 存储 $600/1,000 profiles/月** | 合成 $24/1M（HD $48/1M）+ **训练 $52/compute hour（单次封顶 $936）** + **endpoint hosting $4.032/模型/小时（≈$2,909/月）** |

**合规义务（重要）**：必须事先取得 voice talent 的**书面许可**并提前提供 [Disclosure for voice and avatar talent](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/speech-service/text-to-speech/disclosure-voice-talent)；每个模型只能用于审批过的用例；部署时须向用户披露合成性质。涉及生物特征数据时须履行 GDPR 义务。

> ⚠️ **未能验证**：中国区（21Vianet）是否提供这些能力；官方 regions 表中无中国区域。

### 2.4 pricing（每 1M 字符，USD）

| 项 | 单价 | 备注 |
|---|---|---|
| Neural / Neural HD Flash（实时 + 批量） | **$15.00** | 区域区间 $15–$18.75 |
| Neural HD | **$22.00** | 仅 12 个区域 |
| Professional Voice 合成 | **$24.00**（HD $48.00） | |
| Professional Voice 训练 | **$52/compute hour**，单次封顶 **$936** | |
| Professional Voice endpoint hosting | **$4.032/模型/小时** | ≈$2,909/月（24×7） |
| Personal Voice 合成 | **$24.00** | + profile 存储 $600/1,000 profiles/月 |
| **免费额度（F0）** | **0.5M 字符/月，永不过期** | 仅 Neural TTS |
| 承诺层级 | $960/80M（$12/1M）、$3,900/400M（$9.75/1M）、$15,000/2,000M（$7.5/1M） | 按月承诺，不滚存 |

**关键计费规则（官方文档）**：**每个汉字按 2 个字符计费**（含日文汉字、韩文汉字）。

**→ 每 1,000 个汉字的成本：**

| 音色类型 | 单价 | 1,000 汉字 ≈ |
|---|---|---|
| Standard Neural / HD Flash | $15 / 1M | **≈ $0.030** |
| Neural HD | $22 / 1M | ≈ $0.044 |
| Professional Voice | $24 / 1M | ≈ $0.048（另加训练/托管） |
| Professional Voice HD | $48 / 1M | ≈ $0.096 |

> 这是按"汉字双计"规则的算术推导，**非官网直接标注**；标点、空格、SSML 标记同样计费；实测请以账单为准。
> 第三方（[texttolab.com](https://texttolab.com/blog/azure-text-to-speech-pricing)）报 $16/1M，与官方配额文档里出现的 `$15/1M`、官方定价页内嵌 JSON 的 `$15.00` 有出入 —— **以 $15 为准**。

### 2.5 实时 vs 批量、流式输出与 SDK

| | 实时（Real-time） | 批量（Batch synthesis，GA） |
|---|---|---|
| 单请求音频上限 | **10 分钟** | **无 10 分钟限制**（可做整本书） |
| SSML `<voice>`+`<audio>` 标签数 | ≤50 | — |
| WebSocket 单轮 SSML 大小 | ≤64 KB | — |
| 输入 | 文本或 SSML | `inputKind: PlainText`（需 `voice`）或 `SSML` |
| 结果拼接 | 自行拼接 | **`concatenateResult: true` 直接拼成单个音频** |
| 单 job 输入数 | — | ≤ **10,000** |
| JSON payload | — | ≤ 2 MB |
| REST 限速 | **30 TPS 默认**（S0，可申请提到 1000 TPS）；**F0 = 20 次/60 秒** | 100 请求/10 秒；F0 不支持 |
| 延迟 | 低 | 50% ≤10–20 s，95% ≤120 s |

**流式**：SDK 提供 `synthesizing` 事件逐块回调 `audio_data`；或 `speechsdk.AudioDataStream(result)` 取内存流。官方也明确建议"**可以按文本切片循环合成再自行拼接**"来做超过 10 分钟的音频。

**SDK 包名（用户提到的 `speech_synthesis` **不是**官方包名）：**

| 语言 | 包名 | 安装 |
|---|---|---|
| Python | `azure-cognitiveservices-speech` | `pip install azure-cognitiveservices-speech` |
| Node.js | `microsoft-cognitiveservices-speech-sdk` | `npm install microsoft-cognitiveservices-speech-sdk` |

```js
// Node.js 最小骨架
import { SpeechConfig, AudioConfig, SpeechSynthesizer } from "microsoft-cognitiveservices-speech-sdk";
const speechConfig = SpeechConfig.fromEndpoint(new URL(process.env.ENDPOINT), process.env.SPEECH_KEY);
speechConfig.speechSynthesisVoiceName = "zh-CN-YunxiNeural";
const synthesizer = new SpeechSynthesizer(speechConfig, null); // null = 只要 bytes
synthesizer.speakTextAsync("你好", r => { /* r.audioData: ArrayBuffer */ synthesizer.close(); },
                                    e => { console.error(e); synthesizer.close(); });
```

**配额（S0，per resource）**：实时 TTS **30 TPS 默认**（可申请到 1,000 TPS）；单请求 ≤10 min；SSML 标签 ≤50；WebSocket 消息 ≤64 KB；batch 100 req/10 s。

> ⚠️ 官方特别提示：**多数 TTS 的 HTTP 429 不是配额问题，而是该区域该音色的后端容量不足**，提配额无用。建议在音色的原生区域调用，或换热门音色。**多区域建多个 Speech 资源**是官方推荐的负载分摊方式。

---

## 3. 自建开源中文 TTS（多角色有声书候选）

> 目标能力：**从几秒参考音频零样本克隆**一个角色音，中文质量好，许可允许预期用途，显存可负担。

### 3.1 汇总表

| 项目 | 仓库 | 许可证 | 中文 | 零样本克隆 | 流式 | 近似显存 |
|---|---|---|---|---|---|---|
| **Qwen3-TTS** ⭐ | [QwenLM/Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) | 🟢 **Apache-2.0**（代码 + 全部 6 个权重仓库） | ✅ 10 语言 + 方言音色；Seed-TTS test-zh **CER 0.77**（1.7B）/ 0.92（0.6B） | ✅ **3 秒** | ✅ **97 ms** | ❌ 未文档化（0.6B / 1.7B） |
| **CosyVoice 3 / 2** | [QwenAudio/CosyVoice](https://github.com/QwenAudio/CosyVoice)（原 `FunAudioLLM/CosyVoice` **301 重定向**）· [HF](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512) | 🟢 **Apache-2.0**（代码 + 权重，无附加条款） | ✅ 9 语言 + 18 方言；test-zh CER **1.21**（RL 0.81）/ SS 78.0 | ✅ 代码只强制 **≤30s 上限**（无官方下限） | ✅ 双向 **~150 ms** | ❌ 未文档化 |
| **GPT-SoVITS** | [RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) | 🟢 **MIT**（代码 + HF 权重均 MIT，`gated:false`） | ✅ 含 G2PW 中文前端；⚠️ 官方**无** zh WER/SIM 表 | ✅ **代码硬校验 3s ≤ 参考 ≤ 10s**（`wav16k.shape[0]<48000 or >160000` 报错）；1 分钟微调 | ✅ FastAPI `/tts` 的 `streaming_mode` 1/2/3 | ⚠️ 推理显存未文档化；**微调**：V3 14GB / grad-ckpt 12GB / LoRA 8GB。RTF 0.028@4060Ti、0.014@4090 |
| **IndexTTS-2.5** | [index-tts/index-tts](https://github.com/index-tts/index-tts) · [HF](https://huggingface.co/IndexTeam/IndexTTS-2.5) | 🟡 **bilibili Model Use License**（代码与权重同一许可；>1亿 MAU 或 >10亿元营收须另授权；§3.4(c) 不得用于改进其他 AI 模型；PRC 法 / 上海仲裁） | ✅ zh WER 4.36 / SS 77.10；**2.5-RL 3.93 / 77.92** | ✅ 单参考音频；**代码上限 15s**，无官方下限 | ⚠️ 代码有 `infer_generator(stream_return=True)` 但 README 从不提、CLI/WebUI 未用 | ✅ **官方 ~6GB**（HF 卡）；<10GB 自动低显存模式；RTF 0.2065(bf16)@4090 |
| **Fish Speech / OpenAudio S2** | [fishaudio/fish-speech](https://github.com/fishaudio/fish-speech) | 🔴 **自定义 FISH AUDIO RESEARCH LICENSE**（2026-03-07；代码+权重；**商用须另签书面许可**） | ✅ zh WER **0.54%**（厂商自述，未独立复现） | ✅ 典型 **10–30s**，无下限；支持多说话人参考 `<\|speaker:i\|>` | ✅ `POST /v1/tts`（**仅 WAV**）；TTFA ~100ms、RTF 0.195@H200 | ✅ **≥24 GB**（docs 统一要求）；44.1 kHz |
| **Kokoro-82M-v1.1-zh** | [hexgrad/kokoro](https://github.com/hexgrad/kokoro) · [HF](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh) | 🟢 **Apache-2.0**（代码+权重） | ✅ 需独立权重 + `lang_code='z'`；**基础 v1.0 不含中文** | ❌ **不支持**（decoder-only，未发布 encoder；维护者 [issue #2](https://github.com/hexgrad/kokoro/issues/2) 确认） | ❌ 无 | 🟢 极小（82M，CPU 可跑；有官方 ONNX 导出 + CPU benchmark） |
| **MOSS-TTSD** | [OpenMOSS/MOSS-TTSD](https://github.com/OpenMOSS/MOSS-TTSD) | 🟢 **Apache-2.0** | ✅ 20 语言 | ✅ 短参考（最小秒数未文档化） | ✅ v0.5 起 + SGLang | ❌ 未文档化；32 kHz（v0.7 起）；1–5 说话人、单次 60 分钟 |
| **FireRedTTS-2** | [FireRedTeam/FireRedTTS2](https://github.com/FireRedTeam/FireRedTTS2) | 🟢 **Apache-2.0** | ✅ 7 语言 | ✅ | ✅ 首包 **140 ms**@L20 | ✅ **14GB → 9GB（bf16）**；24 kHz；4 说话人 |
| **Chatterbox**（Resemble AI） | [resemble-ai/chatterbox](https://github.com/resemble-ai/chatterbox) | 🟢 **MIT**（代码与权重均 MIT；turbo/nano/zh-cmn 亦 mit、ungated） | ✅ 仅 multilingual 模型（`language_id="zh"`，23 语言）；base/Turbo/Nano 仅英文 | ✅ `audio_prompt_path`；**代码截断上限 10s**，无下限 | ❌ 无 | ❌ 无 GB 数字（0.5B）；⚠️ **输出强制加 Perth 水印，`generate()` 无关闭参数** |
| **Zonos** | [Zyphra/Zonos](https://github.com/Zyphra/Zonos) | 🟢 **Apache-2.0** | ✅ 英日中法德（中文质量未验证） | ✅ **10–30 s** | ❌ 未宣称 | ✅ **6 GB+**；44 kHz |
| **IndexTTS-2** | 同 IndexTTS 仓库 · [HF](https://huggingface.co/IndexTeam/IndexTTS-2) | 同 bilibili 许可 | ✅ | ✅ | ⚠️ 同上 | 1.5B，支持 FP16 |
| **F5-TTS** | [SWivid/F5-TTS](https://github.com/SWivid/F5-TTS) | 🟡 代码 MIT，**权重 CC-BY-NC** | ✅ zh CER 1.52 | ✅（最小秒数未文档化） | ⚠️ Chunk Inference | ❌ 未文档化（0.3B） |
| **Spark-TTS-0.5B** | [SparkAudio/Spark-TTS](https://github.com/SparkAudio/Spark-TTS) | 🔴 仓库 Apache-2.0，但**权重已改为 CC-BY-NC-SA**（HF 卡有 License Update） | ✅ 中英 | ✅（最小秒数未文档化） | ❌ 未宣称 | ❌ 未文档化 |
| **MegaTTS3**（字节） | [bytedance/MegaTTS3](https://github.com/bytedance/MegaTTS3) | 🟢 Apache-2.0 | ✅ 中英 + code-switching | ⚠️ **WaveVAE encoder 不公开**，须用官方队列生成 `.npy` → **无法自建新角色** | ❌ 不支持 | ❌ 未文档化（用户报告 ~9GB）；24 kHz |
| **ChatTTS** | [2noise/ChatTTS](https://github.com/2noise/ChatTTS) | 🔴 **代码 AGPL-3.0 + 权重 CC BY-NC 4.0** | ✅ 中英（英文 experimental） | ❌ **仅随机 speaker embedding**，无参考音频编码器（[issue #124](https://github.com/2noise/ChatTTS/issues/124) 已 stale 关闭） | ✅ | ✅ **≥4 GB**（30s 音频）；RTF≈0.3；24 kHz |
| **Step-Audio 2** | [stepfun-ai/Step-Audio2](https://github.com/stepfun-ai/Step-Audio2) | 🟢 Apache-2.0 | ✅ 中/粤 | ❌ 未文档化（定位非纯 TTS） | ✅ vLLM 后端 | ❌ 未验证 |
| **NeuTTS** | [neuphonic/neutts](https://github.com/neuphonic/neutts) | Air=Apache-2.0；Nano/2E=NeuTTS Open License 1.0 | ⛔ **不支持中文**（仅英/西/德/法） | ✅ **3 秒** | ⚠️ 仅 GGUF | 🟢 极小（120–360M GGUF） |
| **Higgs Audio v3** | [boson-ai/higgs-audio](https://github.com/boson-ai/higgs-audio) | 🔴 Research & Non-Commercial（生产/托管/营收需商业许可） | ⚠️ 未验证 | ✅ | ✅ | ❌ 未验证（4B） |
| **VibeVoice** | [microsoft/VibeVoice](https://github.com/microsoft/VibeVoice) | MIT | ⛔ **TTS 代码已于 2025-09-05 下架**，HF 标 `Disabled`；仅剩 Realtime-0.5B，**明确 English only + 单说话人 + 音色内嵌不可自定义** | ⛔ TTS 不可用 | ⚠️ 仅英文 | ❌ 未验证 |

> 对照基准（CosyVoice README 官方评测表，越低越好 CER / 越高越好 SS）：
> Human 1.26 / 75.5；Fun-CosyVoice3-0.5B-2512 **1.21 / 78.0**；Index-TTS2 1.03 / 76.5；CosyVoice2 1.45 / 75.7；F5-TTS 1.52 / 74.1；Spark TTS 1.2 / 66.0。

**许可证红线（对商用有声书最关键）：**

| 可用（宽松） | 需谨慎 | **不可商用** |
|---|---|---|
| 🟢 可用（宽松） | 🟡 需谨慎（逐条读） | 🔴 **不可直接商用** |
|---|---|---|
| **Qwen3-TTS**（Apache-2.0，含全部权重） | **IndexTTS-2 / 2.5**（bilibili 自定义许可） | **Fish Speech / OpenAudio S2**（Research License，须另签） |
| **CosyVoice 3 / 2**（Apache-2.0） | **F5-TTS**（代码 MIT，**权重** CC-BY-NC） | **ChatTTS**（权重 CC-BY-NC-4.0 + 代码 AGPL 传染） |
| **GPT-SoVITS**（MIT，代码+权重） | | **Spark-TTS**（权重 CC-BY-NC-SA） |
| **Kokoro-82M / v1.1-zh**（Apache-2.0） | | **Higgs Audio v3**（Research & Non-Commercial） |
| **MOSS-TTSD / FireRedTTS-2 / Chatterbox / Zonos / MegaTTS3 / Step-Audio 2** | | （MegaTTS3 虽 Apache，但**无法自建角色**，功能性排除） |

### 3.2 各项目细节

#### Qwen3-TTS（**许可干净 + 中文最强 + 批量最友好，首选**）

- **Apache-2.0**，代码与**全部 6 个权重仓库**同许可 → 商用无障碍。
- **3 秒**参考音频零样本克隆；**97 ms** 流式延迟。
- Seed-TTS test-zh **CER 0.77**（1.7B）/ 0.92（0.6B）→ 中文发音准确度目前开源第一档。
- **对"多角色 + 多段"最友好**（子代理一手核实）：
  - `create_voice_clone_prompt()` **每个角色只算一次**，之后用 `voice_clone_prompt=` 复用；README 原话大意是"避免重复计算 prompt 特征……在大量台词间保持角色音色一致"。
  - `POST /v1/audio/speech/batch` **一次可提交 1–32 条**。
  - 也可预计算音色后只传 `voice` 名。
- ⚠️ **没有 `/api/tts`**：官方 OpenAI 兼容路径是 `POST /v1/audio/speech`（经 vLLM-Omni，PR #968 于 2026-01-27 合并）。README 里"only offline inference"的说法**已过时**。
- ⚠️ **未能验证**：显存（0.6B / 1.7B 均未文档化）。网上流传的"96GB"是**构建 flash-attn 的主机内存**，**不是显存** —— 不要误信。
- **CustomVoice 预置音色带性别标签**（9 个）：中文女 `Vivian` / `Serena`，中文男 `Uncle_Fu` / `Dylan` / `Eric` 等 —— 这是除 Kokoro 外**唯一**官方提供性别标签的开源方案。

#### CosyVoice 3 / 2

- ⚠️ **仓库已迁移**：`github.com/FunAudioLLM/CosyVoice` → **301 → [github.com/QwenAudio/CosyVoice](https://github.com/QwenAudio/CosyVoice)**（23,597 ★）。权重仍发布在 HF 的 `FunAudioLLM` 组织下。
- **Fun-CosyVoice3-0.5B-2512** 于 2025-12 发布；HF 下载 168k、likes 638（远高于 CosyVoice2 的 4.3k/91）。
- 能力：9 语言、**18+ 中文方言/口音**（粤、闽、川、东北、山西、陕西、上海、天津、山东、宁夏、甘肃…）、跨语种零样本克隆、拼音/CMU 音素发音修补、**双向流式（text-in + audio-out），延迟低至 150ms**、instruct 控制（语言/方言/情感/语速/音量）。
- **多角色缓存机制**：`add_zero_shot_spk()` + `zero_shot_spk_id` + `save_spkinfo()`。
- FastAPI 端点为 `/inference_sft | zero_shot | cross_lingual | instruct | instruct2`（**不是** `/api/tts`）。
- ⚠️ **重要纠正**：网上常见"CosyVoice 参考音频 3–10 s"的说法**不在官方文档里**。官方代码（`webui.py` 注释 + `frontend.py` 硬断言）**只规定 30 s 上限**，**没有官方下限**。
- ⚠️ **未能验证**：显存。0.5B LLM + flow matching + vocoder，需自行 `nvidia-smi` 实测。

#### GPT-SoVITS（**MIT + 最低显存**）

- **MIT**（代码与 HF 权重均 MIT，`gated:false`）。
- ⚠️ **重要纠正**：README 宣传"5 秒"，但**代码硬校验 3 s ≤ 参考音频 ≤ 10 s**（`wav16k.shape[0] < 48000 or > 160000` 直接报错）。准备角色参考片段时必须落在这个区间。
- 1 分钟微调显著提升相似度（"Few-shot TTS"）；跨语种中/英/日/韩/粤。
- 官方 RTF：**0.028（4060Ti）/ 0.014（4090）**（1400 词≈4 分钟音频，4090 上 3.36 s 推理完）。
- 微调显存（官方唯一给出的数字）：**V3 14 GB / 开 gradient checkpointing 12 GB / LoRA 8 GB**。⚠️ **推理显存未文档化**。
- 内置 WebUI + 语音伴奏分离 + 自动切分 + ASR 打标工具链，非常适合**为每个角色准备参考音频**。
- **API**：FastAPI `/tts` 支持 `streaming_mode`（1/2/3）与 `batch_size`（仅单请求内分段）；**无批量端点**，多角色要自己循环。
- ⚠️ **已知 bug（会毁掉有声书）**：隐藏且**默认开启**的 CUDA Graph 会让"你好呀！"这类**短句重复 2–3 次**（[issue #2838](https://github.com/RVC-Boss/GPT-SoVITS/issues/2838)），需手动 `value=False`。
- ⚠️ 官方**无 zh WER/SIM 表**；v1/v2/v2Pro 的输出采样率官方从未给出 Hz。

#### IndexTTS-2.5（**工具链最贴合本场景，但许可需读**）

- bilibili 出品；2026-08-10 发布 2.5，支持中/英/日/西/阿；情绪控制、语速控制（`duration_factor` 0.5x–2.0x）、拼音/CMU/Kana 发音控制。官方 arXiv:2601.03888。
- **`indextts2 batch` 是本报告里唯一原生支持"多角色分段 → 单文件"的官方工具**：
  - 读 **JSON-Lines 清单**，每行可指定 **`voice`（逐段音色 → 原生多角色）** 与 **`silence_after_ms`**；
  - 模型只初始化一次，`--concat` **按清单顺序合并为一个 WAV**；
  - `indextts2 concat` 还能不加载模型直接拼已有 WAV。
- ⚠️ **但官方明示"跨段落韵律不建模"**（默认 200 ms 静音），且 `batch` 是**串行、无并发、无 `--continue-on-error`**。
- **官方显存 ~6 GB**（HF 卡）；<10 GB 自动进入低显存模式，长文按 ≤40 字符切分。RTF 0.2065(bf16)@4090。
- 参考音频**代码上限 15 s**，无官方下限。
- 生产可用 vLLM 部署（[vLLM 配方](https://recipes.vllm.ai/IndexTeam/IndexTTS-2.5)）。
- ⚠️ **许可警告**：`license: other` / `bilibili-model-license`。已知条款：**>1 亿 MAU 或 >10 亿元营收须另获授权**；**§3.4(c) 不得用于改进其他 AI 模型**；适用**中国法律、上海仲裁**。**商用前必须逐条读。**
- ⚠️ **文档缺陷**：`pyproject.toml` 引用了 `INDEX_MODEL_LICENSE*`，但**该文件在仓库中不存在**；DISCLAIMER 里仍残留未填写的 `[开源许可证类型]` / `[国家/地区]` 占位符。
- ⚠️ 仓库内**没有** FastAPI / `/api/tts` 服务（`api_server.py` 404，fastapi 搜索 0 命中）。

#### Fish Speech / OpenAudio S2

- ⚠️ **重要纠正**：当前代码+权重是**自定义 FISH AUDIO RESEARCH LICENSE（2026-03-07）**，原文："Any use … for a Commercial Purpose requires a separate written license agreement."。**CC-BY-NC-SA-4.0 只适用于旧 S1 世代权重**（s1-mini / fish-speech-1.5 / 1.4，均 gated）。当前世代是 **S2-Pro（4B）**。
- S2 Pro 单张 H200：RTF 0.195、**首音延迟 ~100ms**、3,000+ acoustic tokens/s，支持 SGLang 连续批处理 / 分页 KV Cache / CUDA Graph。
- **≥24 GB 显存**（docs 统一要求）；44.1 kHz；`POST /v1/tts` 流式**仅 WAV**。
- zh WER **0.54%** 是**厂商自述**，未独立复现。
- **对本场景（商用有声书）不推荐**，除非确认许可允许。

#### Kokoro-82M / Kokoro-82M-v1.1-zh

- **Apache-2.0**，**82M** 参数，权重极小，**CPU 就能跑**，部署成本最低。
- **Kokoro-82M（v1.0）不支持中文**（HF tags 只有 `en`）。
- **Kokoro-82M-v1.1-zh** 才是中文版：需**独立权重** `hexgrad/Kokoro-82M-v1.1-zh` + `lang_code='z'`。实测权重清单：`zf_*` 女声 **55 个** + `zm_*` 男声 **45 个** + 英文 `af_maple` / `af_sol` / `bf_vale` **3 个**，共 103 个（中文数据由龙猫数据 LongMaoData 提供）。
  - `zf_`：001–008, 017–019, 021–024, 026–028, 032, 036, 038–040, 042–044, 046–049, 051, 059, 060, 067, 070–079, 083–088, 090, 092–094, 099
  - `zm_`：009–016, 020, 025, 029–031, 033–035, 037, 041, 045, 050, 052–058, 061–066, 068, 069, 080–082, 089, 091, 095–098, 100
  - **对"按性别分配角色音"极其合适**：55 女 + 45 男，够分给很多角色。
- **不支持零样本克隆** —— decoder-only，未发布 encoder，维护者 [issue #2](https://github.com/hexgrad/kokoro/issues/2) 确认。
- ⚠️ **与本场景「小段落」直接冲突**：官方 `VOICES.md` 明确"**Weakness on short utterances, especially less than 10-20 tokens**… mitigation is to bundle shorter utterances together"，建议 **100–200 token 一段**。**不要按句切成小段喂给 Kokoro。**
- 训练成本极小（v1.1-zh 只用了 **120 A100-80G 小时 ≈ $110**）。
- ⚠️ **未能验证**：推理显存 GB 数（只有 ONNX 导出脚本 + CPU benchmark）；`v1.1-zh` 是否已进 `kokoro` 包默认发行（模型卡说需要显式传 `repo_id`）。

#### MOSS-TTSD

- **Apache-2.0**，20 语言，短参考克隆（最小秒数未文档化），v0.5 起支持流式 + SGLang。
- **1–5 说话人、单次 60 分钟**，32 kHz 输出（v0.7 起）。
- 定位偏**长对话/播客**，对有声书的多角色对白很合适。
- ⚠️ 显存未文档化。

#### FireRedTTS-2

- **Apache-2.0**，7 语言，4 说话人。
- **显存 14 GB → 9 GB（bf16）** —— 是少数**官方给出显存数字**的模型。
- 首包延迟 **140 ms**@L20，24 kHz。
- 对"低显存 + 流式"场景很有吸引力。

#### Chatterbox（Resemble AI）

- **MIT（代码与权重均 MIT）**，`turbo` / `nano` / `zh-cmn` 亦 mit、ungated —— 许可非常干净。
- 但**只有 `multilingual` 模型支持中文**（`language_id="zh"`，23 语言）；`base` / `Turbo` / `Nano` **仅英文**。
- 克隆用 `audio_prompt_path`；**代码截断上限 10 s**（`DEC_COND_LEN`），无下限。
- ⚠️ **输出强制加 Perth 水印**，`generate()` **没有关闭参数** —— 下游若需要干净音源要先评估。
- ⚠️ 无 GB 显存数字（0.5B）；无流式。

#### Zonos

- **Apache-2.0**，英/日/中/法/德，克隆参考 **10–30 s**，**6 GB+** 显存，44 kHz。
- ⚠️ 中文质量**未验证**。

#### 明确不可用 / 不推荐

- **ChatTTS**：权重 CC BY-NC 4.0 + 代码 AGPL-3.0 双约束；**不能克隆**（只有 `sample_random_speaker()` 高斯采样，无参考音频编码器，[issue #124](https://github.com/2noise/ChatTTS/issues/124) 已 stale 关闭）；官方**故意在 40k 小时模型训练时加高频噪声并压成 MP3**，音质有天花板。**做有声书不达标。**
- **MegaTTS3**：许可 Apache-2.0，但 **WaveVAE encoder 不公开**，必须用官方 Google Drive / 队列生成 `.npy` → **无法自建新角色**，功能性排除。（README 文件名是小写 `readme.md`，用大写会 404。）
- **VibeVoice**：微软 **2025-09-05 从仓库移除了 TTS 代码**，HF 标 `Disabled`；仅存的 Realtime-0.5B 明确 **English only + 单说话人 + 音色内嵌不可自定义** → 中文有声书路径**不可用**。
- **Spark-TTS**：仓库 LICENSE 是 Apache-2.0，但**权重已被官方改成 CC-BY-NC-SA**（HF 卡有明确的 License Update）。
- **NeuTTS**：**不支持中文**（仅英/西/德/法）。
- **Higgs Audio v3**：Research & Non-Commercial，生产/托管/营收需商业许可。

#### 关于"性别"的一个关键事实

> **所有零样本克隆模型的"男女"都是参考音频的属性，不是模型的属性** —— 项目方均不提供性别标签。要男声就喂男声参考片段。
> **例外**：只有 **Kokoro**（`zf_*` 女 / `zm_*` 男）和 **Qwen3-TTS CustomVoice**（9 个带性别预置音色）官方提供性别标签。

#### 采样率不一致 —— 拼接前必须重采样

| 采样率 | 项目 |
|---|---|
| **22.05 kHz** | IndexTTS |
| **24 kHz** | CosyVoice 2/3、Kokoro、ChatTTS、Qwen3-TTS、Chatterbox、FireRedTTS-2、MegaTTS3、GPT-SoVITS v3 |
| **32 kHz** | MOSS-TTSD（v0.7 起） |
| **44 kHz** | Zonos |
| **44.1 kHz** | Fish Speech |
| **48 kHz** | GPT-SoVITS v4 |

> 混用不同模型的音色时，`ffmpeg` 拼装命令里必须统一 `-ar`（见 §1.8）。

---

## 4. 面向本场景的实务对比

### 4.1 服务端集成的难度（Node.js 优先 / Python sidecar）

| 方案 | Node.js 直连 | Python sidecar | 评价 |
|---|---|---|---|
| **edge-tts** | `msedge-tts`（**MIT**，promise API，支持流式 + word/sentence boundary）/ `node-edge-tts`（**MIT**，写文件为主） | `edge-tts` CLI 子进程或 `aiohttp` 服务 | **最容易**：`npm i msedge-tts` 当天可用，无需密钥/账号 |
| **Azure Speech** | ✅ 官方 `microsoft-cognitiveservices-speech-sdk` | ✅ `azure-cognitiveservices-speech` | **需要** Azure 订阅 + key + region，但 API 稳定、有 SLA、有官方 SSML |
| **Qwen3-TTS** | ❌ 无 Node SDK | ✅ **必须 sidecar**；经 vLLM-Omni 暴露 **OpenAI 兼容** `POST /v1/audio/speech` + `POST /v1/audio/speech/batch`（1–32 条） | 接口最接近"标准 HTTP"，Node 侧可直接 `fetch` |
| **IndexTTS-2.5** | ❌ 无 Node SDK | ✅ **必须 sidecar**（CLI `indextts2 batch`，仓库内**无** FastAPI） | 自带批量+拼接，但要包一层 HTTP |
| **CosyVoice 3 / GPT-SoVITS** | ❌ 无 Node SDK | ✅ **必须 sidecar**（CosyVoice 仓库自带 FastAPI；GPT-SoVITS 有 `/tts`，支持 `streaming_mode`） | 需要 GPU 机器 + Python 环境 + 模型权重 |
| **Kokoro-82M-v1.1-zh** | ⚠️ 有社区 ONNX/JS 方案但**未验证** | ✅ `pip install kokoro misaki[zh]`（需 `repo_id='hexgrad/Kokoro-82M-v1.1-zh'`、`lang_code='z'`） | CPU 可跑，sidecar 最轻 |

**侧车（sidecar）建议架构**：Node 主服务 → HTTP `POST /tts {text, voice, rate, pitch}` → Python 服务返回 `audio/wav` 或 `audio/mpeg` 字节 → 主服务按段落顺序落盘 → 最后 `ffmpeg -f concat`（**注意统一 `-ar`**，各模型采样率不同，见 §3.2 末）拼装。

### 4.2 能否给出稳定的"每个角色一个声音"

| 方案 | 稳定性 | 说明 |
|---|---|---|
| **edge-tts** | ⚠️ 中等 | 音色本身稳定（同一 ShortName 每次音色一致），但**只有 14 个中文音色**，且服务随时可能整体 403 |
| **Azure Standard** | ✅ 高 | 22 个 zh-CN Standard 音色 + 8 种 role + 20+ styles，**同一个音色名永远映射同一个声音**（SLA 保证） |
| **Azure HD** | ✅ 高 | 更多音色，但**不支持 role** |
| **自建克隆** | ✅ 最高（音色辨识度） | 给每个角色一段参考音频，音色**完全由你控制**，且不依赖任何外部服务。⚠️ 但需要为每个角色准备/挑选参考片段 |

### 4.3 男 / 女声区分度

| 方案 | 男女区分 | 细节 |
|---|---|---|
| **edge-tts** | ✅ 够用 | 女：`Xiaoxiao`（温暖）、`Xiaoyi`（活泼）、`liaoning-Xiaobei`（幽默）、`shaanxi-Xiaoni`（明亮）；男：`Yunxi`（阳光少年）、`Yunjian`（激情）、`Yunxia`（可爱/童声）、`Yunyang`（专业播音）。**男声层次不如女声丰富** |
| **Azure Standard** | ✅ 很好 | Female "Child" 音色 2 个（`Xiaoshuang`、`Xiaoyou`）+ role=Girl/Boy，可做儿童角色；男声有少年→青年→老年（`Yunze` role=OlderAdultMale/SeniorMale） |
| **自建克隆** | ✅ 最好 | 直接用男/女参考音频，区分度是物理层面的 |

### 4.4 延迟与每 1,000 汉字的成本

| 方案 | 单段延迟 | 每 1,000 汉字成本 | 备注 |
|---|---|---|---|
| **edge-tts** | **1.5–3 s/段**（实测，含固定握手开销） | **$0**（免费，但有法律与稳定性风险） | 10 万字按 2000 字/段 ≈ 110 s；按句切会到小时级 |
| **Azure 实时** | 通常 <1 s（首字节），无实测数据 ⚠️ | **≈ $0.030**（Standard，汉字双计） | F0 免费 0.5M 字符/月 ≈ 25 万汉字/月 |
| **Azure 批量** | 50% ≤10–20 s，95% ≤120 s/请求 | ≈ $0.030（同价） | 单 job 可 10,000 段 + `concatenateResult` 直接拼好 |
| **Qwen3-TTS** | 流式 **97 ms** | $0（电费） | 3 s 克隆；`batch` 端点一次 1–32 条 |
| **GPT-SoVITS（4060Ti）** | RTF 0.028 → 4 分钟音频约 **6.7 s** | **$0**（自有 GPU 电费） | 适合批处理整本；参考音频须 3–10 s |
| **CosyVoice 3** | 流式首包 **150 ms** | **$0**（电费） | 0.5B，单卡可并发 |
| **IndexTTS-2.5** | RTF 0.2065(bf16)@4090 | **$0**（电费） | **~6 GB 显存**；`indextts2 batch --concat` 直接出单文件 |
| **FireRedTTS-2** | 首包 **140 ms**@L20 | $0（电费） | 9 GB（bf16），4 说话人 |
| **Kokoro-82M-v1.1-zh** | CPU 可实时 | **$0**（CPU 电费） | 但无克隆，且**不适合 <20 token 的短段** |

**成本换算参考**：Azure 官方文档给出"1M 字符 ≈ 20.8 小时音频"、"约 48,000 字符/小时语音"。一本 10 万汉字的小说 ≈ 20 万计费字符 ≈ **$3.0**（Standard 实时或批量同价）。

### 4.5 本场景的推荐路径

1. **原型阶段**：`edge-tts`（Python）快速验证分角色、切段、拼接、时间轴对齐的整条流水线。**不要**把 edge-tts 作为最终方案。
2. **生产 / 商用（自建 GPU）**：
   - **首选 Qwen3-TTS**：Apache-2.0 含权重、3 秒克隆、97 ms 流式、`create_voice_clone_prompt()` 每角色只算一次 → **多角色一致性的最佳工程路径**。
   - **要现成的"多角色分段→单文件"流水线**：**IndexTTS-2.5**（~6 GB 显存，`indextts2 batch --concat`）—— 代价是 bilibili 自定义许可。
   - **显存最紧 / 要 MIT**：**GPT-SoVITS**（参考音频严格 3–10 s；记得关掉 CUDA Graph 避免短句重复）。
   - **长对话/播客式**：**MOSS-TTSD** 或 **FireRedTTS-2**（均 Apache-2.0；后者 9 GB、首包 140 ms）。
   - 备选：**CosyVoice 3**（Apache-2.0，`add_zero_shot_spk` 缓存角色、双向流式 150 ms）。
3. **生产 / 商用（不想运维 GPU）**：**Azure AI Speech Standard**，多角色用不同 voice + `mstts:express-as` role/style；长音频走 **batch synthesis + `concatenateResult`**。
4. **零成本兜底、不需克隆**：**Kokoro-82M-v1.1-zh**（Apache-2.0，CPU 可跑，55 女 + 45 男固定音色）。**注意把短句打包成 100–200 token 的段落**再喂进去。
5. **不要选**：ChatTTS（AGPL + 权重非商用 + 音质被故意压缩 + 不能克隆）、Fish Speech / OpenAudio S2（Research License，商用须另签）、Spark-TTS（权重量非商用）、VibeVoice（TTS 代码已下架）、MegaTTS3（无法自建角色）、NeuTTS（不支持中文）、Higgs Audio v3（非商用许可）。

---

## 5. 推荐矩阵（综合结论）

评分：⭐⭐⭐⭐⭐ 最好 / ⭐ 最差。"成本"列 ⭐⭐⭐⭐⭐ = 几乎免费。

| 方案 | 音质 | 成本 | 集成工作量 | 法律风险 | 多角色能力 | 综合建议 |
|---|---|---|---|---|---|---|
| **edge-tts**（Python/Node） | ⭐⭐⭐ | ⭐⭐⭐⭐⭐（$0） | ⭐⭐⭐⭐⭐（1 小时可跑通） | ⚠️ **高**（非官方端点，微软官方提示可能违反 ToS；无 SLA；随时 403） | ⭐⭐⭐（14 个中文音色，无 role/style） | **仅原型/个人用** |
| **Azure AI Speech（Standard）** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐（≈$0.03/千汉字；有 0.5M 字符/月免费） | ⭐⭐⭐⭐（官方 SDK，需订阅+key） | ✅ **低**（官方付费服务，有 SLA） | ⭐⭐⭐⭐⭐（22 音色 + 8 role + 20+ style） | **商用首选（托管方案）** |
| **Azure Neural HD** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐（≈$0.044/千汉字） | ⭐⭐⭐⭐ | ✅ 低 | ⭐⭐⭐（**HD 不支持 role**，靠多 voice 区分） | 追求音质、预算够 |
| **Azure Professional Voice（原 CNV）** | ⭐⭐⭐⭐⭐ | ⭐（合成 $48/1M + 训练 $936 + 托管 $2,909/月） | ⭐⭐（需审批 + 录音 + 训练） | ⚠️ 中（Limited Access、书面授权、披露义务） | ⭐⭐⭐⭐⭐（为每个角色定制） | 品牌级/大规模才值得 |
| **Qwen3-TTS** | ⭐⭐⭐⭐⭐（zh CER 0.77） | ⭐⭐⭐⭐⭐（自有 GPU） | ⭐⭐⭐（Python sidecar） | ✅ **低**（Apache-2.0，含权重） | ⭐⭐⭐⭐⭐（3 s 克隆 + prompt 复用 + batch 1–32） | **自建首选** |
| **IndexTTS-2.5** | ⭐⭐⭐⭐⭐（zh WER 4.36 / SS 77.1） | ⭐⭐⭐⭐⭐（~6 GB 显存） | ⭐⭐⭐⭐（`indextts2 batch --concat` 现成） | ⚠️ **中**（bilibili 自定义许可） | ⭐⭐⭐⭐⭐（逐段 `voice` + 原生拼接） | **工具链最贴合，先读许可** |
| **GPT-SoVITS** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐（4060Ti 级） | ⭐⭐⭐（WebUI + 工具链；无批量端点） | ✅ 低（MIT 代码+权重） | ⭐⭐⭐⭐⭐（参考须 3–10 s） | **最省资源的自建方案** |
| **CosyVoice 3** | ⭐⭐⭐⭐⭐（CER 1.21 / SS 78.0） | ⭐⭐⭐⭐⭐ | ⭐⭐⭐（自带 FastAPI，端点多） | ✅ **低**（Apache-2.0） | ⭐⭐⭐⭐⭐（`add_zero_shot_spk` 缓存） | 自建备选 |
| **MOSS-TTSD / FireRedTTS-2** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐（9–14 GB） | ⭐⭐⭐ | ✅ 低（Apache-2.0） | ⭐⭐⭐⭐⭐（1–5 / 4 说话人） | 多角色对话场景 |
| **Kokoro-82M-v1.1-zh** | ⭐⭐⭐ | ⭐⭐⭐⭐⭐（CPU 即可） | ⭐⭐⭐⭐⭐（pip 装完就能用） | ✅ 低（Apache-2.0） | ⭐⭐⭐⭐（55 女 + 45 男固定音色，**不能克隆**，**短段弱**） | 轻量/无 GPU 场景 |
| **Fish Speech / OpenAudio S2** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐（≥24 GB） | ⭐⭐⭐ | ❌ **高**（Research License，商用须另签） | ⭐⭐⭐⭐⭐ | **商用不推荐** |
| **ChatTTS** | ⭐⭐（故意加噪/压码率） | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ❌ **很高**（AGPL-3.0+ / CC-BY-NC-4.0） | ⭐⭐（随机 embedding，**不能克隆**） | **不推荐** |
| **F5-TTS / Spark-TTS / Higgs Audio v3** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ❌ 高（权重 CC-BY-NC / 非商用） | ⭐⭐⭐⭐ | 研究可用，商用不可 |
| **VibeVoice / MegaTTS3 / NeuTTS** | — | — | — | — | — | **功能性排除**（代码下架 / 无法建角色 / 不支持中文） |

**一句话决策**：
- 想**免费且快** → edge-tts，但接受"随时挂 + 法律灰"。
- 想**合法 + 省心 + 不自建** → Azure AI Speech Standard（多角色用 `zh-CN-XiaomoNeural` / `zh-CN-YunyeNeural` + 多个 voice + `style`）。
- 想**自建 + 许可最干净 + 多角色一致** → Qwen3-TTS（Apache-2.0，3 s 克隆，prompt 复用）。
- 想**现成的分段→拼接流水线** → IndexTTS-2.5（`indextts2 batch --concat`，~6 GB），但先读 bilibili 许可。
- 想**最省显存 + MIT** → GPT-SoVITS（参考音频 3–10 s，关掉 CUDA Graph）。
- 想**不买 GPU、又要合法** → Kokoro-82M-v1.1-zh，从 55 女 + 45 男里挑固定音色（记得短句打包成 100–200 token 段）。

---

## 6. 未能验证 / 不确定清单

1. **edge-tts 的具体限流阈值**：我实测 8 并发时有 1 个请求被拖到 11.6 s，但**没有**收到显式 rate-limit 头，无法给出"每天/IP 多少请求"的确定数字。
2. **微软是否对 edge-tts 使用方采取过法律行动**：只找到服务层面的技术封锁与官方"可能违反 ToS"的表态，**未找到实际执法案例**。
3. **Edge 端点 `pitch` 的精确上下界**：实测 `-50Hz..+200Hz` 生效、`+1000Hz` 未报错；服务端文档未公开边界。`rate` 实测在 `+100%` 处被钳制。
4. **`--volume` 的边界**：本轮**未做**音量维度的实测（只验证了格式正则 `^[+-]\d+%$`）。
5. **`msedge-tts` 的 `OUTPUT_FORMAT` 枚举在我列出的常量名下是否精确**：我用的是 `AUDIO_24KHZ_48KBITRATE_MONO_MP3`，README 示例用的是 `WEBM_24KHZ_16BIT_MONO_OPUS`；⚠️ **具体枚举名请以包内 `src/Output.ts` 为准**（本轮未读到该文件）。
6. **`@andresaya/edge-tts` 在 Node.js（非 Bun）下的可用性**：其 `engines` 只声明 `bun`。
7. **Azure `zh-CN-XiaoxuanNeural`、`zh-CN-XiaoyuNeural`（无后缀）**：官方清单中**不存在**，无法验证。
8. **各 zh-CN Multilingual 音色具体支持哪些语言**：官方文档只给了 `en-US-*MultilingualNeural` 的示范表，未逐条列出中文 Multilingual 音色的语言清单。
9. **中国区（Azure China / 21Vianet）的音色与价格**：官方 regions 表中**无中国区域**，未验证。
10. **`zh-CN-Bo/Lan/Mei/Wei:MAI-Voice-2*` 与 `zh-CN-Maroonallegro:DragonHDOmniLatestNeural` 的定价档**：定价页只给 Standard/HD 两档，这些新语音沿用哪档未确认。
11. **自建模型的推理显存数字**：**没有任何一个零样本克隆项目文档化了推理显存** —— CosyVoice（无）、Qwen3-TTS（无）、MOSS-TTSD（无）、Chatterbox（无 GB 数）、Kokoro（无）、F5-TTS（无）、Spark-TTS（无）、MegaTTS3（无，9 GB 是用户报告）、GPT-SoVITS（只有**微调** 8/12/14 GB）。已文档化的是：**IndexTTS-2.5 ~6 GB**、**FireRedTTS-2 14→9 GB**、**Zonos 6 GB+**、**ChatTTS ≥4 GB**、**Fish Speech ≥24 GB**。
12. **所有"零样本克隆最小参考秒数"**：CosyVoice 只有 **30 s 上限**；IndexTTS 只有 **15 s 上限**；Fish Speech 只有"typically 10–30 s"；Spark-TTS / F5-TTS / MOSS-TTSD / Step-Audio 2 均**未写**。**已硬编码**的只有 GPT-SoVITS（3–10 s）、Chatterbox（≤10 s）。
13. **IndexTTS 的 bilibili Model Use License 完整条款**：已确认的只有 >1 亿 MAU 或 >10 亿元营收须另授权、§3.4(c) 不得用于改进其他 AI 模型、适用 PRC 法律 / 上海仲裁；**未逐条读完**。商用前必须读。
14. **Kokoro-82M-v1.1-zh 各音色 ID 的具体音色特征（年龄/音调/风格）**：✅ 音色 **ID 列表已实测确认**（55 女 + 45 男，见 §3.2），但**每个 ID 听起来是什么样未逐一试听**，需要自己生成样音挑选。
15. **多个"厂商自述"数字未独立复现**：Fish Speech zh WER 0.54%、Chatterbox 水印鲁棒性、NeuTTS "3x realtime"。
16. **部分星标数**：GitHub API 匿名配额在调研期间被耗尽，**未能取得** edge-tts / MsEdgeTTS / node-edge-tts 的 star 数（CosyVoice 的 23,597 ★ 来自子代理当日快照，可信）。
17. **Azure 实时合成的首字节延迟实测**：本轮**没有** Azure 订阅，未做实测；文中延迟数字来自官方文档的批量合成统计。
18. **IndexTTS 仓库内许可证文件缺失**：`pyproject.toml` 引用了 `INDEX_MODEL_LICENSE*`，但**该文件在仓库中不存在**；其 DISCLAIMER 仍残留未填写的 `[开源许可证类型]` / `[国家/地区]` 占位符。这使得其许可状态**在法律上更难确认**。
19. **CosyVoice 官方参考音频上限 30 s 之外的细节**：`frontend.py` 硬断言只给出上限；**没有官方下限**，"3–10 s"是第三方博客说法，**不应作为官方约束引用**。
20. **GPT-SoVITS 官方无 zh WER/SIM 表**（只有 wiki 定性排名）；v1/v2/v2Pro 的输出采样率官方**从未给出 Hz**。

---

## 7. 主要来源

**edge-tts**
- [rany2/edge-tts（GitHub）](https://github.com/rany2/edge-tts) · [PyPI edge-tts 7.2.8](https://pypi.org/project/edge-tts/) · [constants.py](https://github.com/rany2/edge-tts/blob/main/src/edge_tts/constants.py)
- [MsEdgeTTS（GitHub）](https://github.com/Migushthe2nd/MsEdgeTTS) · [npm msedge-tts](https://www.npmjs.com/package/msedge-tts) · [node-edge-tts（GitHub）](https://github.com/SchneeHertz/node-edge-tts) · [npm node-edge-tts](https://www.npmjs.com/package/node-edge-tts) · [npm edge-tts 1.0.1](https://www.npmjs.com/package/edge-tts) · [npm @andresaya/edge-tts](https://www.npmjs.com/package/@andresaya/edge-tts)
- 封锁/稳定性：[#265](https://github.com/rany2/edge-tts/issues/265) · [#286](https://github.com/rany2/edge-tts/issues/286) · [#290](https://github.com/rany2/edge-tts/issues/290) · [#293](https://github.com/rany2/edge-tts/issues/293) · [#401](https://github.com/rany2/edge-tts/issues/401) · [#458](https://github.com/rany2/edge-tts/issues/458) · [#481](https://github.com/rany2/edge-tts/issues/481) · [#482](https://github.com/rany2/edge-tts/issues/482)
- prosody 边界讨论：[#464](https://github.com/rany2/edge-tts/issues/464) · 时间轴漂移修复：[#466](https://github.com/rany2/edge-tts/issues/466) · SSL 开销：[#465](https://github.com/rany2/edge-tts/issues/465)
- 法律：[Are Opensource Edge-TTS free for commercial use?（Microsoft Q&A，官方 Moderator 回答）](https://learn.microsoft.com/en-my/answers/questions/2088770/are-opensource-edge-tts-free-for-commercial-use) · [Unofficial Edge TTS API（Microsoft Q&A）](https://learn.microsoft.com/en-au/answers/questions/2392491/unofficial-edge-tts-api) · [利用 SSML 的语音和音效（zh-tw，role 示例）](https://learn.microsoft.com/zh-tw/Azure/ai-services/speech-service/speech-synthesis-markup-voice)

**Azure AI Speech**
- [语言与语音支持（TTS 表）](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts)
- [SSML 总览](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup) · [SSML voice / style / role](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice) · [SSML 结构](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-structure)
- [TTS 总览与计费规则（含汉字双计）](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech#billable-characters)
- [定价页 Speech in Foundry Tools](https://azure.microsoft.com/en-us/pricing/details/speech/)
- [配额与限制](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits)
- [Batch synthesis API](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/batch-synthesis)
- [Custom voice 总览](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/custom-neural-voice) · [Personal voice 总览](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/personal-voice-overview) · [Limited Access 审批](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/speech-service/text-to-speech/limited-access)
- [快速入门（Python / JS 包名）](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/get-started-text-to-speech) · [How-to 合成（流式事件）](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-speech-synthesis)
- 第三方价格对照：[Azure Text to Speech Pricing (2026)](https://texttolab.com/blog/azure-text-to-speech-pricing)（**与官方有 $1/1M 出入，已标注**）

**自建开源模型**（仓库均于 2026-09-13 核实）
- [QwenLM/Qwen3-TTS（GitHub）](https://github.com/QwenLM/Qwen3-TTS)
- [QwenAudio/CosyVoice（GitHub，原 FunAudioLLM/CosyVoice 301 至此）](https://github.com/QwenAudio/CosyVoice) · [Fun-CosyVoice3-0.5B-2512（HF）](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512) · [CosyVoice2-0.5B（HF）](https://huggingface.co/FunAudioLLM/CosyVoice2-0.5B) · [CosyVoice3 Demos](https://funaudiollm.github.io/cosyvoice3/)
- [RVC-Boss/GPT-SoVITS（GitHub）](https://github.com/RVC-Boss/GPT-SoVITS) · [中文文档](https://www.yuque.com/baicaigongchang1145haoyuangong/ib3g1e) · [CUDA Graph 短句重复 bug #2838](https://github.com/RVC-Boss/GPT-SoVITS/issues/2838)
- [index-tts/index-tts（GitHub）](https://github.com/index-tts/index-tts) · [IndexTTS-2.5（HF）](https://huggingface.co/IndexTeam/IndexTTS-2.5) · [vLLM 配方](https://recipes.vllm.ai/IndexTeam/IndexTTS-2.5)
- [fishaudio/fish-speech（GitHub）](https://github.com/fishaudio/fish-speech) · [Fish Audio S2 博客](https://fish.audio/blog/fish-audio-open-sources-s2/)
- [hexgrad/kokoro（GitHub）](https://github.com/hexgrad/kokoro) · [Kokoro-82M（HF）](https://huggingface.co/hexgrad/Kokoro-82M) · [Kokoro-82M-v1.1-zh（HF）](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh) · [不支持克隆 issue #2](https://github.com/hexgrad/kokoro/issues/2)
- [OpenMOSS/MOSS-TTSD（GitHub）](https://github.com/OpenMOSS/MOSS-TTSD)
- [FireRedTeam/FireRedTTS2（GitHub）](https://github.com/FireRedTeam/FireRedTTS2)
- [resemble-ai/chatterbox（GitHub）](https://github.com/resemble-ai/chatterbox)
- [Zyphra/Zonos（GitHub）](https://github.com/Zyphra/Zonos)
- [2noise/ChatTTS（GitHub）](https://github.com/2noise/ChatTTS) · [ChatTTS（HF）](https://huggingface.co/2Noise/ChatTTS) · [不能克隆 issue #124](https://github.com/2noise/ChatTTS/issues/124)
- [bytedance/MegaTTS3（GitHub）](https://github.com/bytedance/MegaTTS3) · [stepfun-ai/Step-Audio2（GitHub）](https://github.com/stepfun-ai/Step-Audio2) · [neuphonic/neutts（GitHub）](https://github.com/neuphonic/neutts) · [boson-ai/higgs-audio（GitHub）](https://github.com/boson-ai/higgs-audio)
- [microsoft/VibeVoice（GitHub，TTS 代码已下架）](https://github.com/microsoft/VibeVoice)
- [SWivid/F5-TTS（HF）](https://huggingface.co/SWivid/F5-TTS) · [SparkAudio/Spark-TTS-0.5B（HF）](https://huggingface.co/SparkAudio/Spark-TTS-0.5B)

---

## 附录 A：edge-tts 实测原始命令

```bash
# 版本
edge-tts --version            # edge-tts 7.2.8

# 中文音色（活的 Edge 端点）
edge-tts --list-voices | grep -E '^zh-'      # 14 个

# 输出格式验证
edge-tts --voice zh-CN-XiaoxiaoNeural --text "这是一个测试句子，用来测量延迟。" \
         --write-media t1.mp3 --write-subtitles t1.srt
ffprobe -v error -show_entries stream=codec_name,sample_rate,channels,bit_rate \
        -show_entries format=duration -of default=noprint_wrappers=1 t1.mp3
# → mp3 / 24000 / 1 / 48000 / duration=3.696

# 拼接
printf "file '%s'\n" seg_*.mp3 > list.txt
ffmpeg -f concat -safe 0 -i list.txt -c copy full.mp3
```

**并发实测结果（Python `asyncio.gather`，8 并发同文本不同音色）：**

```
#0 Xiaoxiao  2.32s   #1 Yunxi    2.01s   #2 Yunjian  1.68s   #3 Xiaoyi  1.88s
#4 Yunyang   1.88s   #5 Xiaoxiao 11.58s  #6 Yunxi    2.96s   #7 Yunjian 2.99s
wall=11.59s
```

**rate 钳制实测：** `+0%`→6.216s、`+50%`→4.152s、`+100%`→3.144s、`+200%`→**3.144s（与 +100% 相同）**。
