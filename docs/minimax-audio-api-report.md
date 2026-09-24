# MiniMax（海螺）音频生成 API 调研报告

> 面向「有声书（audiobook）多功能角色」功能的选型调研。
> 所有事实性结论均附来源链接；文档矛盾处以官方 OpenAPI 规范为准并明确标注。
> 抓取时间：本报告基于调研当日抓取的官方文档页面（Mintlify 的 `.md` 原文变体）。

---

## 0. 关键结论速览（先读这段）

| 结论 | 说明 |
| :-- | :-- |
| **长文本必须走异步** | 同步 `t2a_v2` 上限 10,000 字符；异步 `t2a_async_v2` 支持 `text` ≤ 5 万字符，上传文本文件 ≤ 100 万字符 |
| **整本书不能一次同步合成** | 一本书需按 5 万字符（直接用 `text`）或 100 万字符（上传 txt/zip）分块 |
| **异步结果只保留 9 小时** | `file_id` 换来的下载 URL 自生成起 9 小时（32,400 秒）失效，必须及时落盘 |
| **没有 webhook** | 官方异步流程是**轮询**：`GET /v1/query/t2a_async_query_v2?task_id=`（限 10 次/秒），未提供回调推送机制 |
| **⚠️ 音色元数据不暴露 gender** | `/v1/get_voice` 返回字段只有 `voice_id` / `voice_name` / `description`，**没有 gender 字段**；系统音色文档表格也只有「语言 / Voice ID / 音色名称」三列。程序无法可靠地按性别自动选音色，只能靠名称字符串启发式判断或人工维护映射表 |
| **当前主推模型** | `speech-2.8-hd` / `speech-2.8-turbo`（文档枚举中列在首位，示例均用 `speech-2.8-hd`） |
| **音乐 API 已对新产品关闭** | 官方公告：自 2026-08-20 起音乐生成/歌词生成付费接口**不再面向新用户提供服务**，免费版（`music-3.0-free` 等）**停止服务** |
| **Node/Python 无官方 TTS 专用 SDK** | 官方提供的是 **MCP server**（Python / JS）与 **CLI**，以及 OpenAI/Anthropic 兼容口（仅用于语言模型，不覆盖 TTS） |

---

## 1. MiniMax T2A（文本转语音）API

### 1.1 同步语音合成 `t2a_v2`

来源：[同步语音合成 HTTP](https://platform.minimax.cn/docs/api-reference/speech-t2a-http)

- **HTTP 方法 + URL**：`POST https://api.minimax.cn/v1/t2a_v2`
  - 国内备用地址（降低首包延迟）：`https://api-bj.minimaxi.com/v1/t2a_v2`
  - 国际站：`POST https://api.minimax.io/v1/t2a_v2`，备用地址 `https://api-uw.minimax.io/v1/t2a_v2`（见 [Text to Speech (T2A) HTTP](https://platform.minimax.io/docs/api-reference/speech-t2a-http)）
- **鉴权**：`Authorization: Bearer <API_key>`（securityScheme `bearerAuth`，`bearerFormat: JWT`）。**新文档不再要求 `GroupId`**（见第 3 节）
- **必填 Header**：`Content-Type: application/json`

**请求 JSON 字段**（`T2aV2Req`）：

| 字段 | 类型 | 必填 | 说明 |
| :-- | :-- | :-- | :-- |
| `model` | string | ✅ | 见 §1.7 模型列表 |
| `text` | string | ✅ | **长度限制 < 10,000 字符**；> 3,000 字符建议用流式；段落用换行符分隔 |
| `stream` | boolean | | 默认 `false` |
| `stream_options.exclude_aggregated_audio` | boolean | | 末包是否含拼接后的完整 hex |
| `voice_setting` | object | | 见 §1.4 |
| `audio_setting` | object | | 见 §1.5 |
| `pronunciation_dict.tone` | string[] | | `"原文/替换内容"`，支持拼音（带调 1–5）、IPA、粤语拼音（1–6）、日语假名 |
| `timbre_weights` | array | | 混合音色，见 §1.4 |
| `language_boost` | string | | 见 §1.6 |
| `voice_modify` | object | | `pitch` / `intensity` / `timbre` 均 `[-100,100]`；`sound_effects` ∈ `spacious_echo` / `auditorium_echo` / `lofi_telephone` / `robotic` |
| `subtitle_enable` | boolean | | 默认 `false` |
| `subtitle_type` | string | | `sentence`（默认）/ `word` / `word_streaming`（仅 `stream=true`） |
| `output_format` | string | | `url` 或 `hex`，**默认 `hex`**；仅非流式生效；`url` 有效期 **24 小时** |
| `aigc_watermark` | boolean | | 默认 `false`，仅非流式生效 |

**文本内联控制语法**（对有声书很有用）：
- 停顿：`<#x#>`，`x` ∈ `[0.01, 99.99]` 秒，最多两位小数，不可连续使用
- 行内注音：`(lɪv)`、`(he2)`、`(sung3)`
- 语气词标签：**仅 `speech-2.8-hd` / `speech-2.8-turbo` 支持**，含 `(laughs)`、`(sighs)`、`(breath)`、`(coughs)`、`(clear-throat)` 等 19 个

**响应 JSON 字段**（`T2aV2Resp`）：

```
data.audio           合成音频（hex 编码；data 可能为 null，需非空判断）
data.subtitle_file   字幕下载链接（句级，≤50 字，毫秒，json）
data.status          1=合成中, 2=合成结束
trace_id             会话 id，排障用
extra_info.audio_length            音频时长（毫秒）
extra_info.audio_sample_rate       采样率
extra_info.audio_size              文件大小（字节）
extra_info.bitrate                 比特率
extra_info.audio_format            取值范围 [mp3, pcm, flac]
extra_info.audio_channel           1 或 2
extra_info.invisible_character_ratio  非法字符占比
extra_info.usage_characters        计费字符数
extra_info.word_count              已发音字数（不含标点）
base_resp.status_code              0 正常 / 1000 / 1001 / 1002 / 1004 / 1039 / 1042 / 2013
base_resp.status_msg
```

> ⚠️ 注意：国际站响应 `extra_info` 示例中还出现 `audio_format`、`audio_channel`，与中文站一致；但 `data.audio` 为 hex 时需自行做 `bytes.fromhex()` 解码落盘。

### 1.2 异步长文本语音合成 `t2a_async_v2`

来源：[创建异步语音合成任务](https://platform.minimax.cn/docs/api-reference/speech-t2a-async-create)、[异步语音合成（指南）](https://platform.minimax.cn/docs/guides/speech-t2a-async)

- **HTTP 方法 + URL**：`POST https://api.minimax.cn/v1/t2a_async_v2`
  - 国际站：`POST https://api.minimax.io/v1/t2a_async_v2`（见 [Create Speech Generation Task](https://platform.minimax.io/docs/api-reference/speech-t2a-async-create)）
- **鉴权**：`Authorization: Bearer <API_key>`；`Content-Type: application/json`

**请求 JSON 字段**（`T2AAsyncV2Req`）：

| 字段 | 类型 | 必填 | 说明 |
| :-- | :-- | :-- | :-- |
| `model` | string | ✅ | 同 §1.7 |
| `text` | string | 二选一 | **最长 5 万字符**（与 `text_file_id` 互斥，必填其一） |
| `text_file_id` | int64 | 二选一 | 文本文件 id。**单文件 < 100 万字符**；支持 `txt`、`zip` |
| `voice_setting` | object | ✅ | 见 §1.4；此处额外有 `english_normalization`（注意：等价于同步接口的 `text_normalization`） |
| `audio_setting` | object | | 注意字段名是 **`audio_sample_rate`**（同步接口是 `sample_rate`）；默认 `channel` 为 **2** |
| `pronunciation_dict.tone` | string[] | | 同同步 |
| `language_boost` | string | | 同 §1.6 |
| `voice_modify` | object | | **仅支持 `mp3` / `wav` / `flac`**，其他格式会返回参数错误 |
| `aigc_watermark` | boolean | | 默认 `false` |

**`text_file_id` 语义**：
- **txt 文件**：< 1,000,000 字符；支持 `<#x#>` 停顿标记
- **zip 文件**：压缩包内需为同一格式的 txt 或 json；json 支持 `title` / `content` / `extra` 三个字段，每个非空字段产出「音频 + 字幕 + 额外信息 JSON」共 **3 个文件**；三字段都存在则共 9 个文件，统一放在一个文件夹中

**响应 JSON 字段**（`T2AAsyncV2Resp`）：

```
task_id           任务 ID（string）
task_token        完成任务使用的密钥信息
file_id           音频文件 ID；请求出错时不返回
usage_characters  计费字符数
base_resp.status_code / status_msg
```

**产出文件**（对 txt 输入）：音频文件（格式随 `audio_setting.format`）+ 字幕文件（句级）+ 额外信息 JSON 文件。

### 1.3 异步生命周期：task_id / 查询 / 下载 / 有效期 / webhook

来源：[查询语音生成任务状态](https://platform.minimax.cn/docs/api-reference/speech-t2a-async-query)、[异步语音合成（指南）](https://platform.minimax.cn/docs/guides/speech-t2a-async)、[文件检索](https://platform.minimax.cn/docs/api-reference/file-management-retrieve)、[文件下载](https://platform.minimax.cn/docs/api-reference/file-management-retrieve-content)

官方推荐四步流程：

1. （可选，文件输入）`POST /v1/files/upload` → 拿 `file_id`
2. `POST /v1/t2a_async_v2` → 拿 `task_id`（同步也直接返回 `file_id`）
3. `GET /v1/query/t2a_async_query_v2?task_id=<id>` → 轮询状态
4. `GET /v1/files/retrieve_content?file_id=<id>` → 下载音频（返回 `application/json`，`format: binary`）

- **查询端点**：`GET https://api.minimax.cn/v1/query/t2a_async_query_v2`，参数 `task_id`（int64，必填，query）
  - **限制：该 API 每秒最多查询 10 次**
- **查询响应**：
  ```
  task_id   任务 ID
  status    状态：Processing / Success / Failed / Expired
  file_id   音频文件 ID（请求出错时不返回）
  base_resp.status_code / status_msg
  ```
  > 文档枚举写作小写 `success/failed/expired/processing`，但 `example` 用 `Processing`、正文用首字母大写。**大小写不一致，建议解析时做 case-insensitive 比较。**
- **下载端点**：
  - 元信息/取链接：`GET /v1/files/retrieve?file_id=<id>` → 返回 `file.file_id` / `bytes` / `created_at` / `filename` / `purpose` / `download_url`
  - 取二进制内容：`GET /v1/files/retrieve_content?file_id=<id>` → 二进制流
- **`file_id` 语义**：任务创建成功后即返回，对应本次合成的音频文件；完成后用 `file_id` 调文件接口下载。**出错时不返回该字段。**
- **有效期 / 保留**：**下载 URL 自生成起 9 小时（32,400 秒）内有效**，过期后文件失效、生成信息丢失。（`output_format: url` 的场景另说：同步接口的 `url` 有效期 24 小时。）
- **Webhook**：❌ **未发现任何 webhook / 回调 / 事件推送机制**。官方文档只描述轮询查询。异步完成通知需自行实现轮询或推送。
- **Task 过期**：查询状态含 `Expired`，说明任务本身会过期，但**文档未给出 task 的具体过期时长**（未验证）。

### 1.4 `voice_setting` 字段与取值范围

来源：[同步语音合成 HTTP](https://platform.minimax.cn/docs/api-reference/speech-t2a-http)

| 字段 | 范围 | 默认 | 备注 |
| :-- | :-- | :-- | :-- |
| `voice_id` | string | 必填 | 支持系统音色 / 复刻音色 / 文生音色（`voice_design`） |
| `speed` | `[0.5, 2]` | `1.0` | |
| `vol` | `(0, 10]` | `1.0` | |
| `pitch` | `[-12, 12]` | `0` | 0 为原音色输出 |
| `emotion` | 枚举 9 值 | 自动 | `happy` / `sad` / `angry` / `fearful` / `disgusted` / `surprised` / `calm` / `fluent` / `whisper` |
| `text_normalization` | boolean | `false` | 中英文文本规范化（提升数字阅读表现，略增延迟）。**同步接口字段名** |
| `english_normalization` | boolean | `false` | **异步接口字段名**（等价能力） |
| `latex_read` | boolean | `false` | 仅支持中文；开启后 `language_boost` 会被强制设为 `Chinese`；公式需 `$$...$$` 包裹；`\` 需转义为 `\\` |

**emotion 可用性细节**（文档明确）：
- `happy`…`calm` 对 `speech-2.8-hd`、`speech-2.8-turbo`、`speech-2.6-hd`、`speech-2.6-turbo`、`speech-02-hd`、`speech-02-turbo`、`speech-01-hd`、`speech-01-turbo` 生效
- `fluent` / `whisper` **仅** `speech-2.6-hd` / `speech-2.6-turbo` 生效
- **`speech-2.8-hd` / `speech-2.8-turbo` 不支持 `whisper`**

**混合音色 `timbre_weights`**（`voice_id` 需置空）：最多 **4 种**音色混合，`weight` ∈ `[1, 100]`，权重越高越像该音色。

### 1.5 `audio_setting` 字段与支持格式

来源：[同步语音合成 HTTP](https://platform.minimax.cn/docs/api-reference/speech-t2a-http)、[创建异步语音合成任务](https://platform.minimax.cn/docs/api-reference/speech-t2a-async-create)

| 字段 | 同步 `t2a_v2` | 异步 `t2a_async_v2` |
| :-- | :-- | :-- |
| 采样率字段名 | **`sample_rate`** | **`audio_sample_rate`** |
| 取值范围 | `[8000, 16000, 22050, 24000, 32000, 44100]`，默认 `32000` | 同左，默认 `32000`。`opus` 格式仅支持 `[8000, 12000, 16000, 24000, 48000]` |
| `bitrate` | `[32000, 64000, 128000, 256000]`，默认 `128000`。**仅对 `mp3` 生效** | 同左 |
| `format` | `mp3`(默认) / `pcm` / `flac` / `wav` / `pcmu_raw` / `pcmu_wav` / `opus` | 同左 |
| `channel` | `[1,2]`，默认 **1** | `[1,2]`，默认 **2** |
| `force_cbr` | boolean，默认 `false`；**仅流式 + mp3 生效** | 未在该 schema 中列出 |

格式说明：`pcmu_raw` / `pcmu_wav` 为 G.711 μ-law 编码（8 kHz，前者无文件头裸数据，后者包在 WAV 容器）；`opus` 为 Ogg/Opus 编码。

### 1.6 `language_boost` 与语言/模型选项

- **字段**：`language_boost`，默认 `null`，可设 `auto` 让模型自主判断
- **枚举（40 项 + auto）**：`Chinese`、`Chinese,Yue`、`English`、`Arabic`、`Russian`、`Spanish`、`French`、`Portuguese`、`German`、`Turkish`、`Dutch`、`Ukrainian`、`Vietnamese`、`Indonesian`、`Japanese`、`Italian`、`Korean`、`Thai`、`Polish`、`Romanian`、`Greek`、`Czech`、`Finnish`、`Hindi`、`Bulgarian`、`Danish`、`Hebrew`、`Malay`、`Persian`、`Slovak`、`Swedish`、`Croatian`、`Filipino`、`Hungarian`、`Norwegian`、`Slovenian`、`Catalan`、`Nynorsk`、`Tamil`、`Afrikaans`、`auto`
- **已知限制**：`speech-01` 与 `speech-02` 系列**暂不支持** `Persian`、`Filipino`、`Tamil`
- **粤语音色需配合**：使用粤语音色（如 `Cantonese_GentleLady`）需将 `language_boost` 设为 `Chinese,Yue`
- 官方宣称支持 **40 种语言**，见 [接口概览](https://platform.minimax.cn/docs/api-reference/api-overview)

### 1.7 可用模型：哪个是当前版本

来源：[同步语音合成 HTTP](https://platform.minimax.cn/docs/api-reference/speech-t2a-http)、[接口概览](https://platform.minimax.cn/docs/api-reference/api-overview)

两个接口的 `model` 枚举**完全一致**：

```
speech-2.8-hd      ← 最新 HD，情绪渲染融合语气词，"重塑自然听感"
speech-2.8-turbo   ← 最新 Turbo，极致生成速度，更自然逼真
speech-2.6-hd
speech-2.6-turbo
speech-02-hd
speech-02-turbo
speech-01-hd
speech-01-turbo
```

- **当前推荐**：`speech-2.8-hd` / `speech-2.8-turbo`。判据：所有官方示例均用 `speech-2.8-hd`；枚举列在首位；`接口概览` 表格标注为「最新的 HD/Turbo 模型」；语气词标签、`whisper` 的例外规则都是围绕 2.8 / 2.6 描述的。
- **情绪（`emotion`）支持**：2.8 / 2.6 / 02 / 01 全系列均支持基础 8 情绪；`fluent`+`whisper` 仅 2.6。
- **多语言（`language_boost`）支持**：全系列支持 40 语言；02-turbo 被描述为「小语种能力加强」。`speech-01`/`speech-02` 不支持 Persian/Filipino/Tamil。
- 注意：「`speech-2.5`」这一名称**未出现在官方 model 枚举中**（未验证其存在性；`music-2.5` 是音乐模型，勿混淆）。

### 1.8 如何枚举音色 —— 以及 gender 元数据的关键问题

#### 端点

**`POST https://api.minimax.cn/v1/get_voice`**（标题「查询可用音色ID」）
来源：[查询可用音色ID](https://platform.minimax.cn/docs/api-reference/voice-management-get)

- **鉴权**：`Authorization: Bearer <API_key>`；`Content-Type: application/json`
- **请求体**：`voice_type`，枚举 `system` / `voice_cloning` / `voice_generation` / `all`
- **响应字段**：
  ```
  system_voice[]        { voice_id, voice_name, description[] }
  voice_cloning[]       { voice_id, description[], created_time }   // yyyy-mm-dd
  voice_generation[]    { voice_id, description[], created_time }
  base_resp.status_code / status_msg
  ```
- **重要行为**：该接口查询**当前账号**下可调用的全部 `voice_id`，包括系统音色、快速克隆音色、文生音色、音乐生成接口的人声音色与伴奏音色。
  > 文档注：**快速复刻得到的音色为未激活状态，需正式调用一次才可在本接口查询到。**
- **系统音色文档页**：[系统音色列表](https://platform.minimax.cn/docs/faq/system-voice-id)（表格列为「语言 / 音色 ID / 音色名称」，共 327 条）

#### ⚠️ GENDER 元数据：**不存在显式字段（已核实）**

**明确结论：官方接口和文档都没有提供 gender 字段。** 证据：

1. `/v1/get_voice` 的 `SystemVoiceInfo` schema 只有三个属性：`voice_id`、`voice_name`、`description`。**没有 `gender`、`sex`、`language` 字段。**（[来源](https://platform.minimax.cn/docs/api-reference/voice-management-get)）
2. 「系统音色列表」文档表格列头为 **序号 / 语言 / 音色 ID / 音色名称**——**有语言，没有性别**。（[来源](https://platform.minimax.cn/docs/faq/system-voice-id)）
3. `description` 是自由文本数组，示例值如 `"一位沉稳可靠的中年男性高管声音，标准普通话，传递出值得信赖的感觉。"`——**性别只以自然语言形式埋在描述文本里，且不保证每个音色都有 description**（示例中 `voice_cloning` / `voice_generation` 的 `description` 均为空数组 `[]`）。

**因此：程序无法通过官方元数据可靠地按性别自动挑选音色。** 可选工程方案：
- 对 `voice_name` / `description` 做关键词启发式匹配（`男` / `male` / `Man` / `Boy` / `Gentleman` / `女性` / `female` / `Lady` / `Girl` …）
- 离线维护一份人工审核过的「角色 → voice_id」映射表（**推荐用于有声书**，因为还涉及年龄/气质匹配）
- 用 `voice_design` 按 prompt 生成指定性别音色（如「低沉富有磁性的男性叙述者」），把结果 `voice_id` 固化进映射表

#### 示例 zh-CN 音色（含性别，供人肉建表）

以下性别为依据 `voice_name` 中文名的推断（**非官方字段，属人工解读**）：

| `voice_id` | `voice_name` | 性别（据名称推断） |
| :-- | :-- | :-- |
| `male-qn-qingse` | 青涩青年音色 | 男 |
| `male-qn-jingying` | 精英青年音色 | 男 |
| `male-qn-badao` | 霸道青年音色 | 男 |
| `male-qn-daxuesheng` | 青年大学生音色 | 男 |
| `female-shaonv` | 少女音色 | 女 |
| `female-yujie` | 御姐音色 | 女 |
| `female-chengshu` | 成熟女性音色 | 女 |
| `female-tianmei` | 甜美女性音色 | 女 |
| `Chinese (Mandarin)_Gentleman` | 温润男声 | 男 |
| `Chinese (Mandarin)_Male_Announcer` | 播报男声 | 男 |
| `Chinese (Mandarin)_Radio_Host` | 电台男主播 | 男 |
| `Chinese (Mandarin)_Reliable_Executive` | 沉稳高管 | 男（描述明确「中年男性」） |
| `Chinese (Mandarin)_News_Anchor` | 新闻女声 | 女 |
| `Chinese (Mandarin)_Sweet_Lady` | 甜美女声 | 女 |
| `Chinese (Mandarin)_Warm_Bestie` | 温暖闺蜜 | 女 |
| `Chinese (Mandarin)_Kind-hearted_Elder` | 花甲奶奶 | 女 |
| `Chinese (Mandarin)_Wise_Women` | 阅历姐姐 | 女 |

来源：[系统音色列表](https://platform.minimax.cn/docs/faq/system-voice-id)

> 🚨 **重大文档缺陷预警**：官方 `t2a_async_v2` 的 cURL 示例使用了 `"voice_id": "audiobook_male_1"`，`t2a_async` 指南的 Python/cURL 示例也用 `audiobook_male_1`。但**该 ID 并未出现在系统音色列表（327 条）中，也未在任何其他地方被记录**。这极可能就是官方示例里的占位符（仅示意「有声书男声」用途）。**切勿直接照抄 `audiobook_male_1`**，否则很可能得到 `2013` 参数错误。请改用上表中的真实 ID。
> 来源：[创建异步语音合成任务](https://platform.minimax.cn/docs/api-reference/speech-t2a-async-create)、[异步语音合成（指南）](https://platform.minimax.cn/docs/guides/speech-t2a-async)

### 1.9 音色克隆 / 音色设计

#### 音色快速复刻（Voice Cloning）

来源：[音色快速复刻](https://platform.minimax.cn/docs/api-reference/voice-cloning-clone)、[上传复刻音频](https://platform.minimax.cn/docs/api-reference/voice-cloning-uploadcloneaudio)、[文件上传](https://platform.minimax.cn/docs/api-reference/file-management-upload)

- **前置条件**：**调用前需先完成个人或企业认证**（否则返回 `2038` 无复刻权限）
- **步骤 1**：`POST https://api.minimax.cn/v1/files/upload`，`Content-Type: multipart/form-data`
  - `purpose` = `voice_clone`（复刻原始文件）或 `prompt_audio`（示例音频）
  - 要求：格式 `mp3` / `m4a` / `wav`；**时长 ≥ 10 秒且 ≤ 5 分钟**；**大小 ≤ 20 MB**
  - 响应：`file.file_id` / `bytes` / `created_at` / `filename` / `purpose`
- **步骤 2**：`POST https://api.minimax.cn/v1/voice_clone`
  - 必填：`file_id`（int64）、`voice_id`（string，自定义）
    - `voice_id` 规则：长度 `[8, 256]`；首字符必须为英文字母；允许数字/字母/`-`/`_`；末位不可为 `-` 或 `_`；不可与已有 id 重复
  - 可选：`clone_prompt.prompt_audio` + `clone_prompt.prompt_text`（示例音频，**时长 < 8 秒**，≤ 20 MB，用于增强相似度与稳定性）
  - 可选：`text`（**≤ 1000 字符**，试听文本；**会产生 TTS 计费**，定价与 T2A 一致）+ `model`（提供 `text` 时必传，枚举同 §1.7）
  - 可选：`language_boost`、`text_validation`（≤ 200 字符，做 ASR 相似度校验，低于 `accuracy` 返回 `1043`）、`accuracy`（`[0,1]`，默认 `0.7`）、`need_noise_reduction`、`need_volume_normalization`、`aigc_watermark`（均 boolean，默认 `false`）
  - 响应：`input_sensitive.type`（风控：0 正常/1 严重违规/2 色情/3 广告/4 违禁/5 谩骂/6 暴恐/7 其他）、`demo_audio`（试听链接）、`extra_info`（试听音频计费信息）、`base_resp`
- **⚠️ 生命周期**：复刻得到的音色**若 7 天内未正式调用，系统会删除该音色**；接口概览补充为「**168 小时（7 天）**内未在任意语音合成接口中使用，该音色将被删除」。（[来源](https://platform.minimax.cn/docs/api-reference/api-overview)）

#### 音色设计（Voice Design / 文生音色）

来源：[音色设计](https://platform.minimax.cn/docs/api-reference/voice-design-design)

- **HTTP 方法 + URL**：`POST https://api.minimax.cn/v1/voice_design`
- **请求**：
  - `prompt`（string，必填）：音色描述，如「讲述悬疑故事的播音员，声音低沉富有磁性，语速时快时慢，营造紧张神秘的氛围。」
  - `preview_text`（string，必填，**≤ 500 字符**）：试听文本（合成会按 2 元/万字符计费）
  - `voice_id`（string，可选）：自定义；不传则自动生成
  - `aigc_watermark`（boolean，默认 `false`）
- **响应**：`voice_id`（生成音色 ID，可用于合成）、`trial_audio`（hex 编码试听音频）、`base_resp`
- **同样适用 7 天未使用即删除的临时音色规则**（[来源](https://platform.minimax.cn/docs/api-reference/api-overview)）
- 历史「文生音色接口」在 2025-06-12 后维持服务但不再迭代（[功能更新](https://platform.minimax.cn/docs/release-notes/apis)）

### 1.10 速率限制、并发、QPS、配额

来源：[速率限制](https://platform.minimax.cn/docs/guides/rate-limits)

**语音（RPM）**：

| 接口 | 免费用户 | 充值用户 |
| :-- | :-- | :-- |
| T2A v2（speech-02-hd/turbo、speech-2.6-hd/turbo、speech-2.8-hd/turbo） | **10** | **20** |
| Voice Cloning | **60** | **60** |
| Voice Design | **20** | **20** |

- **异步查询接口额外限制**：`query/t2a_async_query_v2` **每秒最多 10 次**（[来源](https://platform.minimax.cn/docs/api-reference/speech-t2a-async-query)）
- **限制维度**：RPM（每分钟请求数）与 TPM（每分钟输入+输出 token 数）
- **账号粒度**：**主账号 + 子账号共同享有**同一限额（合计计算），非各自独立
- **超限错误码**：`1002`（限流）、`1039`（触发 TPM 限流）
- **提升限速**：需邮件申请 `api@minimaxi.com`，**可能需 3–5 个工作日**
- **语音资源包可提升 RPM**：套餐一 60 RPM / 套餐二 200 RPM / 套餐三 500 RPM；商务定制为无限 RPM/TPM（[语音资源包](https://platform.minimaxi.cn/docs/guides/pricing-speech)）
- **并发（CONN）**：语音接口文档**未给出** inflight/并发任务数上限（仅视频 H3 写了「最大并行运行任务数 30」、音乐写了 CONN 20）。**语音并发上限：未能验证。**

### 1.11 定价与免费额度

来源：[按量计费](https://platform.minimax.cn/docs/guides/pricing-paygo)、[语音资源包](https://platform.minimax.cn/docs/guides/pricing-speech)

**语音合成（按量，元/万字符）**：

| 计费项 | 模型 | 单价 |
| :-- | :-- | :-- |
| 同步 T2A | `speech-2.8-hd` | **3.50** |
| 同步 T2A | `speech-2.8-turbo` | **2.00** |
| 异步 T2A Async | `speech-2.8-hd` | **3.50** |
| 异步 T2A Async | `speech-2.8-turbo` | **2.00** |
| 历史：`speech-2.6-hd` / `speech-02-hd` | | 3.50 |
| 历史：`speech-2.6-turbo` / `speech-02-turbo` | | 2.00 |

**计费口径（重要）**：以 **10,000 字符（输入）**为单位。**1 个汉字算 2 个字符**；英文字母、希腊字母、标点、特殊符号、空格、回车各算 1 个字符。

**音色管理**：

| 计费项 | 单价 | 计费说明 |
| :-- | :-- | :-- |
| 音色设计 Voice Design | **9.90 元/音色** | 生成时不立即收费，**首次用于合成时才计入**；接口内试听按 2.00 元/万字符 |
| 快速复刻 Voice Cloning | **9.90 元/音色** | 同上；试听字符按所选试听模型单价计费 |

**语音资源包**（预付折扣）：
- HD 系列：¥630 / 200 万字符 / 1 个月（省 10%）；¥5,950 / 2000 万字符 / 3 个月（省 15%）；¥56,000 / 2 亿字符 / 1 年（省 20%）
- Turbo 系列：¥360 / 200 万字符 / 1 个月；¥3,400 / 2000 万字符 / 3 个月；¥32,000 / 2 亿字符 / 1 年
- 均赠送快速克隆音色（10 / 30 / 300 个）

**免费试用额度**：⚠️ **在本次调研的官方定价页与文档中，未找到明确的 TTS 免费试用额度说明。** 文档只区分了「免费用户」（RPM 10）与「充值用户」（RPM 20）两档限速，暗示存在未充值可用状态，但**免费额度多少字符、是否赠送、有效期多久均未说明（未验证）**。

---

## 2. MiniMax 音乐生成 API

来源：[音乐生成](https://platform.minimax.cn/docs/api-reference/music-generation)、[翻唱前处理](https://platform.minimax.cn/docs/api-reference/music-cover-preprocess)、[按量计费](https://platform.minimax.cn/docs/guides/pricing-paygo)、[速率限制](https://platform.minimax.cn/docs/guides/rate-limits)

> 🚨 **服务调整通知（必须先看）**：官方公告——**自 2026 年 8 月 20 日起，付费接口（音乐生成、歌词生成）不再面向新用户提供服务**，历史付费用户可继续使用现有 API；**免费音乐生成接口（`music-3.0-free`、`music-2.6-free`、`music-cover-free`）停止服务**。官方建议改用 [MiniMax Audio](https://www.minimaxi.com/audio) 或开源的 MiniMax Music 3（[Hugging Face](https://huggingface.co/MiniMaxAI/MiniMax-Music3) / [ModelScope](https://modelscope.cn/models/MiniMax/MiniMax-Music3)）。
> **对本项目的含义：如果现在要新接音乐生成做有声书配乐，官方 API 路径可能已不可用，需转向自托管开源模型或 MiniMax Audio 产品。**

### 2.1 通用音乐生成

- **HTTP 方法 + URL**：`POST https://api.minimax.cn/v1/music_generation`
- **鉴权**：`Authorization: Bearer <API_key>`；`Content-Type: application/json`
- **同步/异步**：**同步返回**（非任务制）；支持 `stream: true` 流式。响应 `data.status`：1=合成中，2=已完成。
- **模型**：

| `model` | 说明 | RPM |
| :-- | :-- | :-- |
| `music-3.0`（推荐） | 文本生成音乐，仅 Token Plan 用户和付费用户 | 120 |
| `music-2.6` | 上一代 | 120 |
| `music-cover` | 基于参考音频生成翻唱 | 120 |
| `music-3.0-free` | 限免版，所有用户可用 API Key | 3 |
| `music-2.6-free` | 限免版 | 3 |
| `music-cover-free` | 限免版 | 3 |

- **请求字段**：

| 字段 | 说明 |
| :-- | :-- |
| `prompt` | 风格/情绪/场景描述。<br>· 纯音乐（`is_instrumental: true`，3.0/2.6 系）：**必填**，`[1, 2000]` 字符<br>· 非纯音乐（3.0/2.6 系）：可选，`[0, 2000]`<br>· `music-cover` 系：**必填**，描述目标翻唱风格，`[10, 300]` |
| `lyrics` | 歌词，`\n` 分行。结构标签：`[Intro]`、`[Verse]`、`[Pre Chorus]`、`[Chorus]`、`[Interlude]`、`[Bridge]`、`[Outro]`、`[Post Chorus]`、`[Transition]`、`[Break]`、`[Hook]`、`[Build Up]`、`[Inst]`、`[Solo]`。<br>· 纯音乐：非必填；非纯音乐：**必填** `[1, 3500]`；`music-cover` 系：可选 `[10, 1000]`（不传则 ASR 自动提取） |
| `stream` | boolean，默认 `false` |
| `output_format` | `url` 或 `hex`，默认 `hex`；`stream=true` 时仅支持 `hex`；**`url` 有效期 24 小时** |
| `audio_setting.sample_rate` | `16000` / `24000` / `32000` / `44100` |
| `audio_setting.bitrate` | `32000` / `64000` / `128000` / `256000` |
| `audio_setting.format` | `mp3` / `wav` / `pcm` |
| `aigc_watermark` | boolean，默认 `false`，仅非流式生效 |
| `lyrics_optimizer` | boolean，默认 `false`；仅 3.0/2.6 系。为 `true` 且 `lyrics` 为空时按 `prompt` 自动生成歌词 |
| `is_instrumental` | boolean，默认 `false`；仅 3.0/2.6 系 |
| `audio_url` | 参考音频 URL，**仅 `music-cover` 系**；与 `audio_base64` 二选一，与 `cover_feature_id` 互斥。要求：时长 6 秒–6 分钟、≤ 50 MB、mp3/wav/flac 等 |
| `audio_base64` | Base64 参考音频，规则同上 |
| `cover_feature_id` | 翻唱前处理返回的特征 ID，**仅 `music-cover` 系**，与上两者互斥。传入时 `lyrics` 必填 `[10, 1000]`。**有效期 24 小时**，相同音频内容返回相同 ID（MD5 去重） |

- **响应字段**：
  ```
  data.status   1=合成中, 2=已完成
  data.audio    当 output_format=hex 时返回，16 进制字符串
  base_resp.status_code  0 / 1002(限流) / 1004(鉴权失败) / 1008(余额不足)
                         / 1026(图片描述涉敏) / 2013(参数异常) / 2049(无效 api key)
  ```
  示例中另见 `trace_id`、`extra_info`（`music_duration` 25364 毫秒、`music_sample_rate` 44100、`music_channel` 2、`bitrate` 256000、`music_size` 813651）、`analysis_info`。
- **最大时长**：⚠️ **文档 schema 中未给出 `music_duration` 的上限规定。** 官方示例返回 `music_duration: 25364`（约 25 秒）。**官方文档未声明单曲最大时长（未能验证）。**
- **Instrumental 支持**：✅ 支持。`is_instrumental: true` 生成**纯音乐（无人声）**，此时 `lyrics` 非必填，**`prompt` 必填**——即"从文本 prompt 生成纯器乐背景音乐"是官方支持的能力。
- **复用/延长参考曲目**：`music-cover` 系通过 `audio_url` / `audio_base64` 接受参考音频；`cover_feature_id` 支持两步流程（预处理后改歌词再生成）。**是否支持「延长/续写（extend）」已有曲目：文档未描述该能力（未能验证）。** 文档的 `music-cover` 定位是**翻唱/风格迁移**，不是续写。

### 2.2 翻唱 / 风格迁移（Cover）

**两步翻唱流程**：

1. `POST https://api.minimax.cn/v1/music_cover_preprocess`（[翻唱前处理](https://platform.minimax.cn/docs/api-reference/music-cover-preprocess)）
   - 请求：`model`（必须为 `music-cover`，必填）、`audio_url` 或 `audio_base64`（二选一必填）
   - 响应：`cover_feature_id`（有效期 24 小时，MD5 去重）、`formatted_lyrics`（ASR 提取并格式化的歌词，含 `[Verse]`/`[Chorus]`/`[Bridge]` 等标签，**可修改后回传**）、`structure_result`（JSON 字符串，含段落类型 `intro`/`verse`/`chorus`/`bridge`/`outro`/`inst`/`silence` 及起止时间戳秒）、`audio_duration`（秒）、`trace_id`、`base_resp`
2. `POST /v1/music_generation`，`model: music-cover`，传 `cover_feature_id` + 修改后的 `lyrics` + `prompt`（目标翻唱风格）

> 这正是**"从参考歌曲做风格迁移/翻唱"**的官方 API，满足需求点 2 的 cover 能力。

### 2.3 音乐定价

来源：[按量计费](https://platform.minimax.cn/docs/guides/pricing-paygo)、[速率限制](https://platform.minimax.cn/docs/guides/rate-limits)

| 模型 | 单价 | 状态 |
| :-- | :-- | :-- |
| Music-3.0 | **1.0 元/首** | 已下线 |
| Music-2.6 | **1.0 元/首** | 已下线 |
| 歌词生成 | **0.05 元** | 已下线 |
| Music-2.5+ / 2.5 | 1.0 元/首 | 历史 |
| Music-2.0 | 0.25 元/首 | 历史 |

**速率限制（音乐）**：

| | 免费用户 | 充值用户 |
| :-- | :-- | :-- |
| RPM（music-2.6 / music-cover / music-2.0） | 3 | 120 |
| CONN（最大并行运行任务数） | 3 | 20 |

> 注意：定价页把 `Music-3.0` / `Music-2.6` 标为「已下线」，且顶部公告称付费接口不再面向新用户。**新用户能否调用 `music-3.0`：文档口径矛盾（接口文档列出可用，定价页标已下线），需向官方确认（未能验证）。**

---

## 3. 国际站 vs 中国站端点差异

来源：[MCP README（官方）](https://github.com/MiniMax-AI/MiniMax-MCP)、[同步语音合成 HTTP（国际站）](https://platform.minimax.io/docs/api-reference/speech-t2a-http)、[MCP 指南](https://platform.minimax.cn/docs/guides/mcp-guide)

### 域名对照

| 域名 | 角色 | 备注 |
| :-- | :-- | :-- |
| `api.minimax.io` | **国际站 API**（Global） | 官方 MCP README 指定为 Global Host |
| `api-uw.minimax.io` | 国际站备用 | 「Reduced Time to First Audio (TTFA)」 |
| `api.minimaxi.com` | **中国大陆站 API**（Mainland） | 官方 MCP README 指定为 Mainland Host |
| `api-bj.minimaxi.com` | 中国站备用 | 文档中作为「备用接口地址」 |
| `api.minimax.cn` | **中国站 API（文档中实际使用的域名）** | 所有 `platform.minimax.cn` 文档的 `servers[].url` 均为 `https://api.minimax.cn` |
| `api.minimax.chat` | **旧域名（历史）** | 见下文 GroupId 说明 |
| `platform.minimax.cn` | 中国站**文档/控制台**站 | 文档站 |
| `platform.minimaxi.com` | 中国站**文档镜像/控制台** | `platform.minimax.cn` 的 `.md` 请求会 302 跳到 `platform.minimaxi.com`；控制台登录在此 |
| `platform.minimax.io` | 国际站**文档/控制台** | |

### ⚠️ API Key 与 Host 必须区域对齐

官方 MCP README 明确警告：**"The API host and key vary by region and must match; otherwise, you'll encounter an `Invalid API key` error."**

| Region | Global | Mainland |
| :-- | :-- | :-- |
| `MINIMAX_API_KEY` 获取 | [MiniMax Global 控制台](https://www.minimax.io/platform/user-center/basic-information/interface-key) | [MiniMax 控制台](https://platform.minimaxi.com/user-center/basic-information/interface-key) |
| `MINIMAX_API_HOST` | `https://api.minimax.io` | `https://api.minimaxi.com` |

### 鉴权：`Authorization` vs `GroupId`

- **当前（推荐）方案**：**仅用 `Authorization: Bearer <API_key>`**。`platform.minimax.cn` / `.io` 上所有 T2A / 异步 / 音色 / 文件接口的 OpenAPI `securitySchemes` 都只定义了 `bearerAuth`（`type: http`, `scheme: bearer`, `bearerFormat: JWT`），描述为「`Bearer API_key`」，**没有任何接口把 `GroupId` 列为参数**。
- **`GroupId` 属于旧版 `api.minimax.chat` 时代的鉴权方式**：旧代码把 GroupId 作为 **URL query 参数**传入，例如
  ```
  POST https://api.minimax.chat/v1/t2a_v2?GroupId=<group_id>
  Headers: authorization: Bearer <api_key>
  ```
  可参考一个仍在使用该旧写法的第三方实现：[Open-LLM-VTuber `minimax_tts.py`](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/src/open_llm_vtuber/tts/minimax_tts.py)（`url = "https://api.minimax.chat/v1/t2a_v2?GroupId=" + self.group_id`）。
- **`api_key` 与 `GroupId` 的分工（旧模型）**：`api_key` 是密钥（Bearer 鉴权），`GroupId` 标识所属账号/组织分组，用于路由与计费归属。
- **建议**：新项目**不要**使用 `api.minimax.chat` + `GroupId`；直接使用 `api.minimax.cn`（中国）或 `api.minimax.io`（国际）+ Bearer `api_key`。若沿用旧代码，需确认 `GroupId` 是否仍被接受——**官方现行文档已不再记载，属遗留行为（未能验证其当前有效性）**。
- 中国站还区分两类 Key（[接口概览](https://platform.minimax.cn/docs/api-reference/api-overview)）：
  - **按量付费 API Key**：支持所有模态（语言/视频/语音/图像），按余额扣费
  - **Token Plan 订阅 Key**：用于订阅套餐与积分，**与按量计费 API Key 相互独立**

---

## 4. 官方 SDK 情况

### 4.1 ❌ 没有官方的 TTS 专用 Node.js / Python SDK

- MiniMax 官方 GitHub 组织：[github.com/MiniMax-AI](https://github.com/MiniMax-AI)
- 官方在文档中推荐的接入方式是：
  - **语言模型**：用 **OpenAI SDK** 或 **Anthropic SDK** 兼容口
    - OpenAPI 兼容：`export OPENAI_BASE_URL=https://api.minimax.cn/v1`（[前置准备](https://platform.minimax.cn/docs/guides/quickstart-preparation)）
    - Anthropic 兼容：`export ANTHROPIC_BASE_URL=https://api.minimax.cn/anthropic`
    - ⚠️ **这两个兼容口只覆盖语言模型（Chat/Messages），不覆盖 T2A / 音乐 / 音色克隆**
  - **多模态（含 TTS）**：官方提供 **MCP server** 与 **CLI**，而非常规 SDK
- 搜索中出现的 `minimax_python_sdk`、`minimax-api`（npm）等**均为第三方包，非官方**（例如 [chenyuqing/minimax_python_sdk](https://github.com/chenyuqing/minimax_python_sdk) 是个人仓库）。
- **结论：如需要 Node/Python 封装，需自行基于 REST 实现，或使用官方 MCP / CLI。**

### 4.2 官方 MCP Server

来源：[MiniMax MCP 指南](https://platform.minimax.cn/docs/guides/mcp-guide)、[MiniMax-MCP（GitHub）](https://github.com/MiniMax-AI/MiniMax-MCP)

| 实现 | 包/仓库 | 安装 |
| :-- | :-- | :-- |
| Python | [`MiniMax-AI/MiniMax-MCP`](https://github.com/MiniMax-AI/MiniMax-MCP)，PyPI `minimax-mcp` | `uvx minimax-mcp` |
| JavaScript | [`MiniMax-AI/MiniMax-MCP-JS`](https://github.com/MiniMax-AI/MiniMax-MCP-JS)，npm `minimax-mcp-js` | `npx -y minimax-mcp-js` |

- 传输方式：Python 版支持 **stdio / SSE**；JS 版支持 **stdio / REST / SSE**
- 环境变量：`MINIMAX_API_KEY`、`MINIMAX_API_HOST`（`https://api.minimax.io` 或 `https://api.minimaxi.com`）、`MINIMAX_MCP_BASE_PATH`、`MINIMAX_API_RESOURCE_MODE`（`url` | `local`，默认 `url`）
- **工具清单**：`text_to_audio`、`list_voices`、`voice_clone`、`voice_design`、`play_audio`、`generate_video`、`image_to_video`、`query_video_generation`、`text_to_image`
- **最小用法（Claude Desktop / Cursor 配置）**：
  ```json
  {
    "mcpServers": {
      "MiniMax": {
        "command": "uvx",
        "args": ["minimax-mcp"],
        "env": {
          "MINIMAX_API_KEY": "<your api key>",
          "MINIMAX_API_HOST": "https://api.minimaxi.com",
          "MINIMAX_MCP_BASE_PATH": "/path/to/output",
          "MINIMAX_API_RESOURCE_MODE": "url"
        }
      }
    }
  }
  ```
- ⚠️ MCP 指南中的 `text_to_audio` 默认值为 `voice_id: "female-shaonv"`、`model: "speech-02-hd"`、`emotion: "happy"`，`format` 可选 `["pcm","mp3","flac","wav"]`——**注意默认模型是较旧的 `speech-02-hd`，且默认 `emotion` 为 `happy`**，用于有声书需显式覆盖。

### 4.3 官方 CLI

- [MiniMax-AI/cli](https://github.com/MiniMax-AI/cli)（`mmx-cli`），官方 MCP README 推荐其替代 MCP：「official command-line tool with the latest models and additional features including text, vision, and search」；文档页 [MiniMax CLI](https://platform.minimax.cn/docs/token-plan/minimax-cli)
- ⚠️ 本次抓取 `https://github.com/MiniMax-AI/cli` **失败**（网络错误），因此**未能验证其具体命令与版本（未验证）**。

### 4.4 官方 REST 最小用法（推荐用于有声书后端）

```bash
# 同步短文本
curl -X POST https://api.minimax.cn/v1/t2a_v2 \
  -H "Authorization: Bearer $MINIMAX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "speech-2.8-hd",
    "text": "今天是不是很开心呀(laughs)，当然了！",
    "stream": false,
    "voice_setting": { "voice_id": "male-qn-qingse", "speed": 1, "vol": 1, "pitch": 0, "emotion": "happy" },
    "audio_setting": { "sample_rate": 32000, "bitrate": 128000, "format": "mp3", "channel": 1 }
  }'
```
（来源：[同步语音合成 HTTP](https://platform.minimax.cn/docs/api-reference/speech-t2a-http)）

---

## 5. 文档矛盾与未能验证之处（务必阅读）

| # | 项目 | 状态 |
| :-- | :-- | :-- |
| 1 | **音色 gender 元数据** | ❌ **已核实不存在**（`/v1/get_voice` schema 与系统音色列表表格均无 gender 字段）。程序无法可靠按性别自动选音色 |
| 2 | **`audiobook_male_1`** | 🚨 出现在官方异步示例中，但**不在 327 条系统音色列表里**，疑为占位符。**不可直接使用** |
| 3 | **异步 `text` 上限** | 官方 OpenAPI 规范与 `.io` 版均写 **50,000 字符**；但 `guides/speech-t2a-async` 说「单个文件长度限制小于 10 万字符」，`接口概览` 说「单次最长 100 万字符」。**三处口径不一**。以 OpenAPI 为准：`text` ≤ 5 万，`text_file_id` ≤ 100 万 |
| 4 | **异步状态大小写** | 枚举写 `success/failed/expired/processing`，example 写 `Processing`，正文写 `Success`。**解析需 case-insensitive** |
| 5 | **task 过期时长** | 状态含 `Expired`，但**未给出 task 具体过期时间**（未验证） |
| 6 | **`audio_url` 有效期** | 混用：异步任务下载 URL **9 小时**；同步 `output_format: url` 与音乐 `output_format: url` 为 **24 小时** |
| 7 | **音乐单曲最大时长** | **官方未声明上限**（未验证） |
| 8 | **音乐 `music-3.0` 可用性** | 定价页标「已下线」+ 公告「付费接口不再对新用户开放」，但接口文档仍列为推荐可用。**口径矛盾** |
| 9 | **TTS 免费试用额度** | **未找到明确说明**（未验证） |
| 10 | **语音并发上限（CONN）** | **文档未给出**（未验证） |
| 11 | **`GroupId` 当前是否仍被接受** | 现行文档完全不提，属遗留行为（未验证） |
| 12 | **`speech-2.5` 是否存在** | 未出现在官方 model 枚举中（未验证，勿与 `music-2.5` 混淆） |
| 13 | **音乐"延长/续写参考曲目"** | 文档只描述 cover 翻唱，**未见 extend 能力**（未能验证） |
| 14 | **MiniMax CLI 具体命令** | 仓库抓取失败（未验证） |

---

## 6. 多角色有声书：什么最关键

### 6.1 架构建议

**主链路用异步 `t2a_async_v2`，不要用同步接口逐段调用。**

理由与做法：

1. **分块策略**
   - 方案 A（推荐，省事）：把整本书按章节/角色块切成 **≤ 5 万字符**的片段，用 `text` 直接 POST。一次请求出一整块音频，减少了轮询次数。
   - 方案 B（大书）：把文本打包成 **txt 或 zip（≤ 100 万字符）**，先 `POST /v1/files/upload`（`purpose=t2a_async_input`）拿 `text_file_id`，再 `POST /v1/t2a_async_v2`。产出「音频 + 句级字幕 + 额外信息 JSON」三件套。
   - **关键约束：一次请求内 `voice_id` 是固定的**。多角色意味着**每个角色的台词必须拆成独立的异步任务**，各自用不同 `voice_id`，最后按时间线拼接。这是有声书工程化的核心复杂度，MiniMax 没有"单请求多音色对话"的原生能力（`timbre_weights` 是混合成一个音色，不是多角色对话）。
2. **异步生命周期管理**
   - 每块：`POST /v1/t2a_async_v2` → 存 `task_id` → 轮询 `GET /v1/query/t2a_async_query_v2?task_id=` → 状态 `Success` 后 `GET /v1/files/retrieve_content?file_id=` 落盘
   - **没有 webhook**，必须自建轮询器。注意查询接口**限 10 次/秒**，且 T2A RPM 充值用户仅 **20**（免费 10）——**并发很容易撞限流**。多角色 + 多章节会迅速放大请求数，**上线前务必评估是否需要申请提额（`api@minimaxi.com`，需 3–5 工作日）或购买语音资源包（60/200/500 RPM）**。
   - **9 小时硬窗口**：`file_id` 的下载 URL 只在 9 小时内有效。**轮询到 Success 后必须立即下载归档**，否则需重新合成（重新计费）。
3. **音色选型（本报告最大风险点）**
   - **官方不提供性别元数据**，所以"程序自动按男女选音色"**做不到可靠**。请：
     - 离线维护一份**人工审核的「角色 → voice_id」映射表**（本项目直接硬编码/配置化）
     - 需要时用 `voice_design` 按 prompt 定制角色音色（如「低沉磁性悬疑男声」），生成后把 `voice_id` 固化
     - **注意临时音色 7 天未使用即被删除**——固定角色音色必须**在 7 天内至少合成一次**保活，否则要重新生成并重新付费（9.90 元/音色）
   - **切勿使用文档示例里的 `audiobook_male_1`**，它在系统音色表中不存在
   - 已验证可用的 zh-CN 男声：`male-qn-qingse`、`male-qn-jingying`、`male-qn-badao`、`Chinese (Mandarin)_Gentleman`、`Chinese (Mandarin)_Male_Announcer`、`Chinese (Mandarin)_Radio_Host`；女声：`female-shaonv`、`female-yujie`、`female-chengshu`、`female-tianmei`、`Chinese (Mandarin)_News_Anchor`、`Chinese (Mandarin)_Sweet_Lady`
4. **用 2.8 系列换表现力**
   - `speech-2.8-hd` 支持 **19 个语气词标签**（`(sighs)` `(laughs)` `(breath)` …）——这是有声书"演播感"的关键差异化能力，**只有 2.8 支持**，2.6/02/01 都没有。
   - `emotion` 可做角色/场景级情绪标注，但**注意 2.8 不支持 `whisper`**（旁白低语场景需退回 `speech-2.6-hd/turbo`）——**这是一个真实的选型权衡：要么用 2.8 拿语气词、要么用 2.6 拿 whisper，鱼与熊掌**。
   - 停顿控制 `<#x#>` 对章节停顿、留白节奏很实用。
5. **输出规格**
   - 推荐 `format: mp3`、`audio_sample_rate: 44100`、`bitrate: 256000`、`channel: 2`（异步默认就是 channel 2）。追求无损归档可用 `wav` 或 `flac`。
   - 注意异步接口字段名是 **`audio_sample_rate`**，不是 `sample_rate`——和同步接口不同，**这是一个很容易踩的坑**。
   - 想要字幕/时间戳：异步任务自动附带**句级字幕文件**；同步接口需显式 `subtitle_enable: true`。
6. **成本估算**
   - **计费陷阱：1 个汉字算 2 个字符**。一本 30 万汉字的中文书 ≈ **60 万计费字符** ≈ 60 万 / 1 万 × 2.00 元（turbo）= **约 120 元**；用 hd 则约 **210 元**。多角色拆块会因重叠/重试略有上浮。
   - 对比资源包：Turbo 套餐一 ¥360 / 200 万字符，若能消耗完则单价低于按量。
7. **音乐配乐（如果要做）**
   - 纯器乐背景音乐：`is_instrumental: true` + `prompt`（必填，≤ 2000 字符），且 `lyrics` 可省。
   - **但先解决可用性问题**：官方已公告付费音乐接口不再对新用户开放、免费版停止服务。**建议优先走自托管 MiniMax Music 3 开源模型，或直接采购无版权音乐库**，不要把有声书配乐强绑在 MiniMax 音乐 API 上。

### 6.2 一句话总结

MiniMax 的 TTS 完全能支撑有声书（异步 100 万字符长文本 + 句级字幕 + 30 万音色 + 2.8 语气词 + 9.9 元定制音色），**但有两个必须提前设计的硬约束**：(1) **voice 元数据没有性别字段**，多角色音色映射必须人工维护而非自动发现；(2) **异步结果 9 小时过期且无 webhook**，必须自建"轮询 + 立即落盘"的可靠流水线，并对 **20 RPM** 的限流做节流与重试。音乐配乐则建议绕开官方 API（已对新用户关闭）。

---

## 附：主要来源清单

- [同步语音合成 HTTP（中国站）](https://platform.minimax.cn/docs/api-reference/speech-t2a-http)
- [创建异步语音合成任务（中国站）](https://platform.minimax.cn/docs/api-reference/speech-t2a-async-create)
- [查询语音生成任务状态（中国站）](https://platform.minimax.cn/docs/api-reference/speech-t2a-async-query)
- [异步语音合成（指南）](https://platform.minimax.cn/docs/guides/speech-t2a-async)
- [查询可用音色ID](https://platform.minimax.cn/docs/api-reference/voice-management-get)
- [系统音色列表](https://platform.minimax.cn/docs/faq/system-voice-id)
- [音色快速复刻](https://platform.minimax.cn/docs/api-reference/voice-cloning-clone)
- [上传复刻音频](https://platform.minimax.cn/docs/api-reference/voice-cloning-uploadcloneaudio)
- [音色设计](https://platform.minimax.cn/docs/api-reference/voice-design-design)
- [文件上传](https://platform.minimax.cn/docs/api-reference/file-management-upload)
- [文件检索](https://platform.minimax.cn/docs/api-reference/file-management-retrieve)
- [文件下载](https://platform.minimax.cn/docs/api-reference/file-management-retrieve-content)
- [音乐生成](https://platform.minimax.cn/docs/api-reference/music-generation)
- [翻唱前处理](https://platform.minimax.cn/docs/api-reference/music-cover-preprocess)
- [速率限制](https://platform.minimax.cn/docs/guides/rate-limits)
- [按量计费](https://platform.minimax.cn/docs/guides/pricing-paygo)
- [语音资源包](https://platform.minimax.cn/docs/guides/pricing-speech)
- [接口概览](https://platform.minimax.cn/docs/api-reference/api-overview)
- [前置准备](https://platform.minimax.cn/docs/guides/quickstart-preparation)
- [功能更新](https://platform.minimax.cn/docs/release-notes/apis)
- [MiniMax MCP 指南](https://platform.minimax.cn/docs/guides/mcp-guide)
- [Text to Speech (T2A) HTTP（国际站）](https://platform.minimax.io/docs/api-reference/speech-t2a-http)
- [Create Speech Generation Task（国际站）](https://platform.minimax.io/docs/api-reference/speech-t2a-async-create)
- [MiniMax-MCP（官方 GitHub）](https://github.com/MiniMax-AI/MiniMax-MCP)
- [MiniMax-MCP-JS（官方 GitHub）](https://github.com/MiniMax-AI/MiniMax-MCP-JS)
- [MiniMax-AI 官方组织](https://github.com/MiniMax-AI)
- [Open-LLM-VTuber minimax_tts.py（旧 GroupId 写法实例）](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/src/open_llm_vtuber/tts/minimax_tts.py)
