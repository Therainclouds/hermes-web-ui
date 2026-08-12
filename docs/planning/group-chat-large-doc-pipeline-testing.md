# 群聊大文件文档管道 —— 测试手册（Windows 开发机 → RK3528 设备）

> 创建日期：2026-08-12
> 适用版本：v0.7.17 + 本功能（未提交分支 `test/dual-protocol-dev`）
> 规格依据：[group-chat-large-doc-pipeline-spec.md](./group-chat-large-doc-pipeline-spec.md) §9 测试计划
> 场景：开发机为 Windows，目标设备为 RK3528 / Armbian（3.8G 内存，4 核，69max-rk3528）
> 目标：先在 Windows 上跑通 1MB 冒烟 → 再到设备上做 1MB 冒烟 + 100MB 真实模拟，按验收表出结论

---

## 0. 两阶段测试总览

| 阶段 | 环境 | 内容 | 目的 |
|---|---|---|---|
| A. Windows 开发机 | 本机 Git Bash + npm | 单元/集成测试 + build + 1MB 链路（mock 模型） | 快速回归，验证代码正确性 |
| B. 设备冒烟 | RK3528 真机 | 1MB 真实文件全链路（真实 API 调用） | 验证真实模型链路、内存/CPU 约束 |
| C. 设备真实模拟 | RK3528 真机 | 100MB 大文件全自动跑完 | 验证防爆炸机制与验收指标 |

> ⚠️ 文档管道当前**未提交**（工作区改动），部署到设备前需先提交或打包。

---

## 1. 前置：Windows 开发机（阶段 A）

### 1.1 环境
- Node ≥ 23（`node:sqlite` 需要）
- 依赖安装：`npm ci --ignore-scripts`
- 命令一律在仓库根目录执行

### 1.2 快速回归（每次改动后必跑）
```bash
# 服务端类型检查
npx tsc --noEmit -p packages/server/tsconfig.json

# 前端类型检查
npx vue-tsc -b

# 文档管道相关测试（parser 11 个 + pipeline 集成 3 个）
npx vitest run tests/server/group-chat-document-parser.test.ts tests/server/group-chat-document-pipeline.test.ts

# 群聊全量相关测试
npx vitest run tests/server/group-chat-* 2>/dev/null || npx vitest run tests/server/group-chat-baseline.test.ts tests/server/group-chat-routes-baseline.test.ts tests/server/group-chat-discussion.test.ts tests/server/group-chat-room-summary.test.ts

# 构建（含 openapi 生成）
npm run build

# 仓库级检查（chat-chain fragment 等）
npm run harness:check
```

**已知环境性测试失败**（与本次功能无关，基线已确认）：
- `write-gate-service` / `agent-bridge-*` / `coding-agent-*` / `gateway-respawn` 等测试在 Windows 上因 `spawn fake-python` ENOENT 失败。判断方法：`git stash` 后重跑同一文件仍失败 → 环境问题。

### 1.3 Windows 上的人工冒烟（可选，mock 模型）
文档管道模型调用走 `runBareModelAgent`（真实 provider），Windows 开发机如无可用 API key，可跳过真实精读；代码正确性已由 pipeline 集成测试覆盖（mock 了模型调用）。

---

## 2. 前置：设备冒烟与真实模拟（阶段 B/C）

### 2.1 设备部署
- 部署目录：`/opt/hermes-web-ui`（source 部署，systemd 服务 `hermes-web-ui.service`）
- 数据目录：`HERMES_WEB_UI_HOME`（部署脚本默认 `${APP_USER_HOME}/.hermes-web-ui`，即通常 `~/.hermes-web-ui`）
- Web UI 数据库：`<HERMES_WEB_UI_HOME>/hermes-web-ui.db`（**注意：不是 `state.db`**；`state.db` 是 Hermes agent 自己的库，见 §2.4）
- 上传/文档目录：
  - 普通上传：`<HERMES_WEB_UI_HOME>/upload/`
  - 文档管道落盘：`<HERMES_WEB_UI_HOME>/group-chat-docs/{roomId}/{fileId}/upload.bin`

### 2.2 服务管理
```bash
sudo systemctl status hermes-web-ui
sudo systemctl restart hermes-web-ui
sudo journalctl -u hermes-web-ui -f
```

### 2.3 部署新版到设备（本功能未提交时）
1. 先在仓库提交/打包当前改动
2. 走 `scripts/deploy-source-armbian.sh` 或手动更新 `dist/`（按团队既有设备更新流程）
3. 确认 6 张新表已建：`<HERMES_WEB_UI_HOME>/hermes-web-ui.db` 里应出现 `gc_documents` 等表

### 2.4 数据库确认（设备）
```bash
DB=<HERMES_WEB_UI_HOME>/hermes-web-ui.db
sqlite3 "$DB" ".tables" | tr ' ' '\n' | grep '^gc_'   # 应含 gc_documents/gc_file_chunks/gc_document_fields/gc_document_facts/gc_reading_jobs/gc_volume_summaries
```
> 若设备未装 sqlite3：`sudo apt-get install -y sqlite3`

---

## 3. 阶段 B：设备 1MB 冒烟（真实 API）

### 3.1 准备测试文件
在设备上生成（或上传）1MB 中文合同：

```bash
mkdir -p /tmp/gc-doc-test && cd /tmp/gc-doc-test
# 生成 1MB UTF-8 合同（60 段条款，含金额/日期/法条/当事人）
python3 - <<'PY'
import random
lines = ['房屋租赁合同', '', '甲方：张三', '乙方：北京某某科技有限公司', '']
for i in range(1, 3000):
    lines.append(f'第{i}条 甲方应于202{i%10}年{(i%12)+1}月{(i%28)+1}日向乙方支付人民币{(i*10000):,}元。')
    lines.append(f'本条款适用《中华人民共和国民法典》第{i}条规定，甲方与乙方另有约定除外。')
text = '\n'.join(lines)
open('contract_1mb.txt', 'w', encoding='utf-8').write(text)
print('size:', len(text.encode('utf-8')) // 1024, 'KB')
PY

# 另生成一份 GBK 编码样本测编码嗅探（可选）
python3 - <<'PY'
text = open('contract_1mb.txt', encoding='utf-8').read()
open('contract_1mb_gbk.txt', 'w', encoding='gbk').write(text)
print('gbk sample written')
PY
```

### 3.2 冒烟步骤（浏览器操作）
1. 浏览器打开 Web UI → 群聊 → 新建房间 → 添加 **5 个 agent**（确认每个 agent 的 provider/model/apiMode 已配置，能真实出 API）
2. 房间设置 → 「文档整理」→ 上传 `contract_1mb.txt`
3. 预期：
   - 上传成功 → 显示「文档上传成功」+ 文档卡片状态「待精读」+ 块数（1MB 中文约 4-8 块）
   - 选择 agent（或默认全部 5 个）→「开始精读」
   - 卡片出现进度条，`精读 N/M 块` 递增
   - 状态流转：精读中 → 汇总中 → 已完成
   - 群聊消息流出现终稿（条款矩阵 + 风险清单 + 冲突清单 + 待办），发送者为「文档整理」
4. 同时观察服务端日志：
   ```bash
   sudo journalctl -u hermes-web-ui -f | grep -E "DocumentPipeline|document|group-chat-document"
   ```

### 3.3 冒烟验收清单（1MB）
| # | 检查项 | 通过标准 |
|---|---|---|
| B1 | 上传/切块 | 状态 `chunked`，块数 > 0，文档卡片显示块数 |
| B2 | 编码嗅探 | UTF-8 样本显示 `utf-8`；GBK 样本显示 `gbk/gb18030` 且内容无乱码 |
| B3 | 精读推进 | 进度条持续增长到 100%，无 job 卡死 |
| B4 | 卷摘要 | 块数 > 10 时日志出现 volume summary 调用（`purpose=group-chat-document-volume`） |
| B5 | 聚合终稿 | 状态 `done`，群聊出现终稿消息，4 部分齐全 |
| B6 | 防循环 | 终稿消息不触发 agent 再次 @回复（无循环刷屏） |
| B7 | 无 OOM | 全程设备可用内存未跌破 500MB 熔断线（`free -m` 观察） |
| B8 | 失败路径 | 断网/坏 API key 上传后精读：job 标记 failed，文档状态 `failed` 或重试后恢复 |

---

## 4. 阶段 C：设备 100MB 真实模拟

### 4.1 准备 100MB 文件
```bash
python3 - <<'PY'
import random
lines = ['大型合同汇编', '']
# 拼接不同主题条款段落，保证有结构锚点可切块
topics = ['支付条款', '违约责任', '保密条款', '知识产权', '争议解决', '交付验收', '终止与清算']
for i in range(1, 400000):
    t = topics[i % len(topics)]
    lines.append(f'第{i}条【{t}】甲方应于202{i%10}年{(i%12)+1}月{(i%28)+1}日支付人民币{(i*137):,}元，逾期按《中华人民共和国民法典》第{(i%580)+1}条处理。')
text = '\n'.join(lines)
open('contract_100mb.txt', 'w', encoding='utf-8').write(text)
import os
print('size MB:', os.path.getsize('contract_100mb.txt') // 1024 // 1024)
PY
# 预期 ~100MB，~400-450 块
```

### 4.2 运行
重复 §3.2 步骤，上传 `contract_100mb.txt`，5 agent 全量精读。**预计耗时 0.5-1.5 小时**（受 API 限流与模型速度影响）。期间保持设备不进入省电/休眠。

### 4.3 压测监控（三开终端）
```bash
# 终端 1：内存 + CPU（观察是否撞 3.8G / 熔断）
watch -n 5 'free -m; echo ---; ps -o pid,rss,%cpu,etime -p $(pgrep -f "dist/server/index.js")'

# 终端 2：管道日志
sudo journalctl -u hermes-web-ui -f | grep -E "document-pipeline|ReadingJob|contextTokenEstimate|volume summary|memory low"

# 终端 3：SQLite 状态
DB=<HERMES_WEB_UI_HOME>/hermes-web-ui.db
watch -n 10 'sqlite3 "$DB" "SELECT status, COUNT(*) FROM gc_file_chunks GROUP BY status; SELECT COUNT(*) AS facts FROM gc_document_facts; SELECT COUNT(*) AS fields FROM gc_document_fields; SELECT COUNT(*) AS volumes FROM gc_volume_summaries;"'
```

### 4.4 重启续跑验证（关键验收项 #8）
1. 精读进行中（进度 30-50%）时：`sudo systemctl restart hermes-web-ui`
2. 重启后确认：pending job 继续被消费，进度**从断点续跑**而非清零
3. 若 job 曾标记 failed：`attempts < 3` 的应自动 requeue

### 4.5 防爆炸验证
| 场景 | 操作 | 预期 |
|---|---|---|
| 内存熔断 | 故意压内存（如另开 2 个大进程） | 日志出现 `memory low, pausing`，恢复后自动继续 |
| 单 job 失败 | 中断网络 30s | 失败 job 重试（attempts 递增），网络恢复后续跑 |
| 无 OOM | 全程 | 设备 RSS 不持续增长，无 `heap out of memory` 崩溃 |

---

## 5. 验收标准对照表（阶段 C 结束后填写）

| # | 指标（spec §9.5） | 通过线 | 实测 |
|---|---|---|---|
| 1 | 全程无 OOM / V8 heap 超限 | 0 次 | |
| 2 | 每 agent 每轮上下文 | ≤55K tokens（日志验证） | |
| 3 | 主进程内存增量 | <200MB | |
| 4 | 100MB 全自动跑完 | <1.5 小时 | |
| 5 | 已知条款/金额/日期抽取率 | 规则字段 100%；AI 语义 ≥95% | |
| 6 | quote 溯源校验 | 100% 通过（机械校验） | |
| 7 | 终稿四要素 | 条款矩阵+风险清单+冲突清单+待办 全有 | |
| 8 | 重启后续跑 | 不丢 job，续跑成功 | |
| 9 | 5 agent 吞吐 | ≥3.5× 单 agent 基线 | |
| 10 | GBK 文件 | 编码嗅探正确，无乱码 | |
| 11 | document_report 消息 | 不触发 mention/总结循环 | |

### 5.1 吞吐对照（验收 #9）
在 1MB 或 100MB 上做两次对比：
```bash
# 单 agent：上传后「开始精读」只选 1 个 agent，记录总耗时 T1
# 5 agent：同文件选 5 个 agent，记录总耗时 T5
# 吞吐比 = T1 / T5，验收 ≥ 3.5
```

### 5.2 quote 溯源抽查（验收 #6，机械校验）
随机抽 3-5 条事实，用 SQLite 校验 quote 是否在原文中存在：
```bash
DB=<HERMES_WEB_UI_HOME>/hermes-web-ui.db
# 取一条 fact
sqlite3 "$DB" "SELECT fact_json FROM gc_document_facts LIMIT 3;"
# 人工核对：quote 片段必须逐字存在于 <HERMES_WEB_UI_HOME>/group-chat-docs/{roomId}/{fileId}/upload.bin
grep -F "「quote 原文片段」" <HERMES_WEB_UI_HOME>/group-chat-docs/*/*/upload.bin
```

---

## 6. 常见问题（FAQ）

| 症状 | 排查 |
|---|---|
| 上传报 413 | 文件 > 100MB（`MAX_GROUP_DOC_SIZE` 环境变量可调）；或走错了 `/upload`（50MB 限）而非 `/documents` |
| 上传报 415 | 扩展名不在 `.txt/.md/.docx`；PDF 文本提取未实现 |
| 精读不推进 | `journalctl` 看 `runBareModelAgent` 是否报错（API key/模型配置）；文档卡片确认 agent 已选且模型可出 API |
| 进度 0 / 全 failed | 检查 `gc_reading_jobs` 的 `error` 字段：`sqlite3 "$DB" "SELECT error FROM gc_reading_jobs WHERE status='failed' LIMIT 5;"` |
| 终稿没出现 | 确认 `gc_documents.status='done'` 且 `report_message_id` 有值；群聊消息流里找「文档整理」消息 |
| GBK 乱码 | 确认样本真的是 GBK 编码；`detectDocType` 前 `sniffEncoding` 应返回 `gbk/gb18030` |
| Windows 测试失败 | 见 §1.2 环境性失败说明（Python spawn） |

---

## 7. 交付物

阶段 C 完成后，产出：
1. 本文件 §5 验收表填写完成（含实测数据）
2. 压测日志摘录（内存/CPU/进度曲线关键点）
3. 已知问题清单（如有 failed job、偏差指标）

> 文档管道未提交；设备部署前先提交并走设备更新流程。
