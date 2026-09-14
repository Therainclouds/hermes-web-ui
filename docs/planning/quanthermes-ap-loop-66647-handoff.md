# quanthermes 设备 6.6.6.47 热点配网死循环问题 —— 交接文档（转 quanthermes 项目组）

> 日期：2026-08-19
> 设备：6.6.6.47（hostname `qh-3533ccc5`，RK35xx aarch64，Armbian，内核 6.1.115-vendor-rk35xx）
> 现场状态：**当前已自愈**（设备已连上 WiFi `Quant_Speed`，5 个服务全部 active，今天 0 报错），但 8-18 晚出现过约 2.7 小时的热点启动死循环。

---

## 一、用户反馈的现象

- 设备有 USB OTG 虚拟网卡（RNDIS，固定 IP 10.0.0.2）。**用 USB 线访问 10.0.0.2 之前，热点（AP）配网是稳定的；使用之后**，AP 模式下手机能连上热点，但：
  1. 连上后**无法自动跳转到配网界面**（captive portal 不生效）；
  2. 连接后**突然断开，过一会又自己启动，然后重复**。
- 用 USB 访问期间/之后设备曾有一次重启（8-18 晚）。

## 二、排查结论（一句话）

**quanthermes 服务进程本身没有崩溃/重启（NRestarts=0，21h 稳定运行），但 v1.3.4-fb 的状态机在"配网目标 WiFi 连不上"时陷入热点启动死循环：热点被反复拉起→拆掉→拉起，导致手机反复掉线、配网页（DNS 劫持）来不及生效。**

## 三、证据链（全部来自设备实机日志）

### 时间线（设备 journal 时间；注意开机时钟有偏差，实际时间可能整体偏移约 2h）

| 时间 | 事件 |
|---|---|
| 08-18 17:39:06 | 开机完成，quanthermes / hermes-web-ui / usb-gadget 启动 |
| 08-18 17:39:20 | NM audit：**删除 YCKJ2 的 connection profile**（当时 config.json 配网目标就是 YCKJ2） |
| 08-18 17:39:34 | NM：首次激活热点 `quanthermes-ap` |
| 08-18 17:40:14 ~ 20:11 | quanthermes 反复报 `report skipped, network not ready (ssid=YCKJ2)` |
| 08-18 17:40:22 ~ 20:20:18 | **热点启动死循环**（详见下） |
| 08-18 17:39 ~ 20:20 | NM 日志：`quanthermes-ap` 每 ~37s 激活一次、运行 30~40s 后被拆（user-requested）、30~60s 后再拉起，循环约 2.7 小时 |
| 08-18 20:19:46~20:20:13 | 热点最终被拆；NM 尝试连 `Quant_Speed` 报 **no-secrets**（profile 重写竞态，PSK 暂时缺失） |
| 08-18 20:20:58 | **config.json 被改写（YCKJ2 → Quant_Speed），循环立即停止** |
| 08-19 10:20:30 | wlan0 经 DHCP 获得 6.6.6.47，连上 Quant_Speed，之后一直稳定 |

### 死循环的直接日志证据（quanthermes journal，每 30~60 秒一轮，无限重复）

```
Warning: AP start disconnect wlan0 failed: exit status 6:
  Error: Device 'wlan0' (/org/freedesktop/NetworkManager/Devices/5) disconnecting failed: This device is not active
Error: not all devices disconnected.
```

NM 侧对应证据（同一时段）：

```
device (wlan0): Activation: starting connection 'quanthermes-ap' ...
audit: op="connection-activate" ... name="quanthermes-ap" ... result="success"
audit: op="connection-deactivate" ... name="quanthermes-ap" ... result="success"   ← 30~40s 后被拆
```

### 为什么配网页不跳转

- 配网页依赖 NM shared 模式 dnsmasq 的 DNS 劫持：`/etc/NetworkManager/dnsmasq-shared.d/90-quanthermes-captive.conf` 内容为 `address=/#/192.168.4.1`。
- 热点每次只存活 30~40 秒就被拆掉，手机的连通性检测/DNS 劫持流程来不及完成；且热点反复重启期间 NM 的 dnsmasq 报 `chown of PID file /run/nm-dnsmasq-wlan0.pid failed: Operation not permitted`（次要，需确认是否影响劫持生效）。

## 四、根因假设（请 quanthermes 团队核实）

1. **触发条件**：配网目标 WiFi 无法连接。本次是 YCKJ2 连不上（其 NM profile 在开机 17:39:20 被删除、且未按 config.json 重建 → wlan0 永远无活动连接）。
2. **核心 bug（疑似）**：热点启动流程的"前置断开 wlan0"步骤，把 `nmcli device disconnect wlan0` 的 **exit 6 "This device is not active"**（即 wlan0 本来就未激活）**误判为致命错误**，打印 `Error: not all devices disconnected` 后中止热点启动，随后进入无限重试。
3. **加剧因素**：循环中热点会被短暂拉起（NM 激活成功），但 ~30~40s 后被守护进程自身拆掉（user-requested deactivate），形成"起来→拆→起来"的抖动，每个周期 ~37~90s。手机只能赶上极短的存活窗口，表现为"能连上→突然断开→又自己启动→重复"。

## 五、已排除的项（避免重复排查）

| 怀疑点 | 结论 | 依据 |
|---|---|---|
| usb0 (10.0.0.2/24) 与热点网段冲突 | **排除** | 热点网段是 192.168.4.0/24（`quanthermes-ap` profile：`ipv4.addresses 192.168.4.1/24, method shared`），与 usb0 不冲突 |
| USB gadget 服务异常/插拔触发重启 | **排除** | usb-gadget.service 为 RemainAfterExit，只在开机跑一次；插拔线不触发任何服务动作 |
| USB DHCP 干扰路由 | **排除** | `/etc/dnsmasq-gadget.conf` 特意 `port=0`（禁 DNS）、无网关（无 dhcp-option=3），只发 10.0.0.10~20 的 IP |
| quanthermes 进程崩溃 | **排除** | NRestarts=0，21h 未重启，内存 18.9M |
| 设备反复重启 | **排除** | uptime 20h，journal 仅 1 次 boot |
| USB 与问题无直接机制关联 | **倾向排除** | USB 本身无破坏 AP 的机制；更可能是 USB 会话期间把配网目标改成了连不上的 YCKJ2，之后设备重启暴露了上述 bug |

## 六、请 quanthermes 团队确认/修复的点

1. **`disconnect wlan0` 返回 "not active"（exit 6）应视为"已断开"（no-op 成功），不应中止热点启动。** 这是本次死循环的直接入口。
2. **开机删除 NM profile 后应按 config.json 重建连接**（YCKJ2 profile 被删后未重建 → WiFi 永远连不上 → 触发热点兜底 → 暴露 bug）。
3. **热点激活后的状态机收敛**：确认为何激活后 ~30~40s 又被自身拆掉（user-requested），不应周期性 deactivate/activate。
4. **1.3.4-fb vs 1.3.3 差异**：当前版本 1.3.4-fb（8-14 更新），`device_state.json` 中 `lastKnownGoodVersion: 1.3.3`。请确认 1.3.4-fb 是否改动过 AP 启动/网络状态机逻辑；若 1.3.3 无此问题，可评估回滚作为应急。
5. **NM shared dnsmasq 的 `chown of PID file failed`**：确认是否会导致 captive portal DNS 劫持在热点重启后失效。

## 七、复现方法（供验证修复）

1. 把配网目标 WiFi 设为**连不上的 SSID**（或删除其 NM profile），重启设备或 `systemctl restart quanthermes`；
2. 观察：`journalctl -u quanthermes -f` 出现 `AP start disconnect wlan0 failed ... This device is not active` 循环；
3. 对照：`journalctl -u NetworkManager -f | grep quanthermes-ap` 可见热点反复 activate/deactivate。

## 八、附带发现（次要，可一并处理）

- **hermes-web-ui.service** 开机时 ExecStartPre（`generate-server-cert.sh`）连续失败 13 次（17:39:27~17:40:24），导致 6060 端口服务在 17:40~19:31 不可用，之后恢复正常（疑似网络未就绪的启动竞态）。
- **hermes-agent** 有 4 个 `hermes gateway run --replace` 进程并存（疑似重启残留；agent-bridge 本身健康，pid 5816，restart_attempts 0）。
- **开机时钟偏差**：journal 时间与 uptime 相差约 2h（NTP 校正前），做时间对齐时需注意。

## 九、设备访问方式（供复现/核查）

- SSH：`root@6.6.6.47`（端口 22），密码由现场人员提供；
- 远程 API：`http://6.6.6.47/api/status`（配网守护进程，端口 80）、`http://6.6.6.47:6060/health`（hermes-web-ui）；
- 本机（Windows）留存 paramiko SSH 辅助脚本 `tmp_device_ssh.py`，可执行任意命令并回显。
