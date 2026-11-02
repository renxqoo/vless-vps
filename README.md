# vless-vps

自建代理：Xray（VLESS）+ Hysteria2（QUIC）+ Let's Encrypt IP 证书（6 天短效，acme.sh 自动续期）+ Bun 订阅服务 + 换号脚本。

## 架构

```
客户端 (Clash Verge / mihomo)
   │
   ├─ 443  Xray VLESS + Vision (TLS 1.3)
   ├─ 2053 Xray VLESS + WebSocket（备用线路）
   ├─ 2096 Hysteria2 / QUIC + salamander 混淆（UDP，抗丢包）
   │
   └─ 8443 Bun 订阅服务（src/vless-sub-server.ts）
          ├─ /<secret>/sub    按 User-Agent 返回 Clash YAML / base64 节点列表
          ├─ /<secret>/vless  返回全部分享链接（hysteria2:// 与 vless://）
          └─ subscription-userinfo 响应头 = vnstat 月流量（total 可配）
```

三条线路各自独立建连（不启用 mux / smux），单条连接拥塞不影响其他连接。Hysteria2 走 UDP，在丢包链路上吞吐明显优于基于 TCP 的 VLESS；VLESS 线路作为非 UDP 网络下的回退。

## 组成

| 路径 | 说明 |
|---|---|
| `src/vless-sub-server.ts` | Bun 订阅服务：多节点列表、故障转移/自动选择分组、国内直连规则、流量展示 |
| `deploy/vless-url` | 服务器换号脚本：生成新 UUID → 热替换 → 旧 URL 立即失效，失败自动回滚 |
| `deploy/vless-sub.service.example` | systemd 单元模板（占位符见内文） |
| `deploy/xray-config.example.json` | Xray 配置模板（443 Vision + 2053 WS）；需替换 `HOST_PLACEHOLDER` / `UUID_PLACEHOLDER` / `WS_PATH_PLACEHOLDER` 后作为 `/usr/local/etc/xray/config.json` |
| `deploy/hysteria-config.example.yaml` | Hysteria2 服务端配置模板（2096 QUIC + salamander 混淆） |
| `deploy/hysteria.service.example` | Hysteria2 systemd 单元模板 |
| `deploy/99-vless-udp.conf` | Hysteria2 所需的 16 MB UDP 缓冲上限（按需分配） |
| `deploy/vless-status` | 只读健康检查：服务、证书、UDP 缓冲、TLS 校验与订阅完整性，不输出凭证 |
| `deploy/vless-egress-guard` | 为代理服务组安装持久 UFW IPv4/IPv6 出站隔离，保留服务回复和系统 DNS |
| `deploy/vless-service-hardening.conf` | systemd 通用沙箱和资源上限；Xray 另需仅授予绑定低端口的能力 |
| `deploy/vless-reload-certs` | root 执行的证书权限修复及三服务重载钩子 |
| `deploy/ssh-key-only.conf.example` | SSH 仅公钥认证，禁用密码与键盘交互 |
| `.env.example` | 环境变量清单 |

## 配置

服务启动时先读同目录 `.env`（已存在的环境变量优先），必填：

- `VLESS_HOST` 服务器 IP 或域名
- `SUB_SECRET` 订阅路径密钥
- `WS_PATH` WebSocket 路径

可选（端口、证书路径、网卡、流量总额度）见 `.env.example`。

流量通过异步 `vnstat` 读取，默认缓存 30 秒（`TRAFFIC_CACHE_TTL_MS`）；并发请求共用一次采样，缓存到期时先返回已有数据并在后台刷新。采样失败保留上次结果；启动后尚无有效采样时才回退到 `/proc/net/dev`（该回退是开机以来的接口流量，并非月流量）。UUID 每次请求重新读取，换号后无需等待缓存过期。

`/<secret>/sub` 继续按客户端 User-Agent 自动返回 YAML 或 base64，也可在 URL 后加 `?format=clash`、`?format=base64`、`?format=links` 固定格式。订阅响应禁止中间缓存，支持 `GET` 和 `HEAD`。密码、混淆密码和 WS 路径中的特殊字符会正确转义。

Clash 默认优先「故障转移」，按 Hysteria2 → Vision → WebSocket 顺序使用可用线路，每 60 秒检查一次，失败阈值设为 2 以更早触发强制健康检查。Hysteria2 保留自动拥塞控制，避免固定速率限制长下载。「自动选择」仍按延迟选线，50 ms 容差减少小幅抖动引发的切换。两组均通过 HTTPS 204 检查连通性，手动选择会保留；已有客户端更新订阅后需在「节点选择」切到「故障转移」以使用该优先策略。流量显示使用客户端订阅信息，不再添加不可用的“流量节点”。客户端全局覆写的设置仍以客户端为准。

规则首项仅让服务器自身地址直连：IPv4 使用单地址 `/32`，域名使用精确 `DOMAIN`；其余流量仍遵循国内直连及末尾代理规则。启用 TUN 的客户端还可将服务器单地址加入「排除自定义网段」，使服务器控制连接明确走物理网卡。本机已设置该排除项；仅看到系统路由指向 TUN，并不足以证明代理核心存在出站循环。

Hysteria2 节点由三个变量控制：`HY2_AUTH` 留空则订阅里不出现该节点；填入后需与 `/etc/hysteria/config.yaml` 的 `auth.password` 一致。`HY2_OBFS` 对应 `obfs.salamander.password`，两边必须相同，留空则不加混淆。

## 部署要点

1. Xray 官方脚本安装；证书用 acme.sh `--certificate-profile shortlived` 签 IP 证书（Let's Encrypt，6 天有效期，ARI 自动排期续期），`--install-cert --reloadcmd /usr/local/sbin/vless-reload-certs` 挂钩加载新证书，三个服务共用同一份证书。`vless-sub` 只在启动时 `readFileSync` 证书并交给 `createServer`，不重启就会一直用旧证书，续期后订阅端点会返回过期证书导致客户端拉订阅失败，所以钩子里必须包含它。当前使用 HTTP-01 standalone 验证，必须放行 `80/tcp`，该端口只在验证时临时监听；单独配置 cron 而不放行端口会导致续期一直失败。参考 [acme.sh standalone 文档](https://github.com/acmesh-official/acme.sh#4-use-standalone-server-to-issue-cert)。
2. Bun 装在 `/usr/local/bin/bun`；服务器运行 `bun run /usr/local/bin/vless-sub-server.js`（`bun build` 产物，`deploy:build` 一键推进）；密钥在 `WorkingDirectory` 的 `.env`（`root:xray 0640`）。订阅服务以 `vless-sub` 用户、`xray` 组运行，所以 bun 不能放在 `/root`（`0700`，服务用户无法穿越）。
3. 流量统计依赖 `vnstat`（接口名 `NET_IF`）。
4. 换号：服务器执行 `vless-url`，输出新分享链接和订阅地址；客户端更新订阅即可。Hysteria2 用密码认证，不受 UUID 换号影响。
5. Hysteria2 安装：下载 `hysteria-linux-amd64` 到 `/usr/local/bin/hysteria`，按 `deploy/hysteria-config.example.yaml` 写 `/etc/hysteria/config.yaml`（600，`root` 所有但属组可读时用 `root:xray` + `0640`，因为服务以 `vless-hysteria` 用户、`xray` 组运行），用 `deploy/hysteria.service.example` 建 unit 并 `systemctl enable --now hysteria`。
6. 证书目录为 `root:xray 0750`，证书与私钥均为 `root:xray 0640`。Xray、Hysteria2、订阅服务分别使用 `xray`、`vless-hysteria`、`vless-sub` 用户，主组均为 `xray`，只有读取证书的权限。续期钩子 `/usr/local/sbin/vless-reload-certs` 会恢复该权限并重启三个服务；须先将 `deploy/vless-reload-certs` 安装为 root 所有、0700。服务账号应为无密码、`/usr/sbin/nologin` 的系统账号。
7. `deploy/` 下所有模板只作参考，不会被任何脚本自动部署；线上真实值在服务器，模板内统一使用 `HOST_PLACEHOLDER` / `HOST_IP_CIDR_PLACEHOLDER` / `UUID_PLACEHOLDER` / `WS_PATH_PLACEHOLDER` 等占位符。安装时手工替换 `HOST_PLACEHOLDER`（IP 证书场景下 `serverName` 必须等于证书 SAN 里的地址），并写入 `/usr/local/etc/xray/config.json`。

## 性能与日常检查

```bash
bun run status              # 默认通过 ssh wr 检查；也可设置 VLESS_SSH_TARGET
bun test                    # 真实 HTTPS 进程测试，使用临时证书和配置
bun run typecheck
bun run build
```

在新服务器上，将 `deploy/99-vless-udp.conf` 安装为 `/etc/sysctl.d/99-vless-udp.conf`，执行 `sysctl -p /etc/sysctl.d/99-vless-udp.conf`，然后重启 `hysteria`，使套接字重新申请缓冲。只提高收发缓冲的上限，不预分配 16 MB；TCP 已启用 BBR + fq 时无需重复调整。参数依据 [Hysteria 官方性能文档](https://v2.hysteria.network/docs/advanced/Performance/)。

2026-11-02 检查：服务器约 1.9 GiB 内存、负载接近零，BBR 已启用；UDP 收发缓冲上限仅 212,992 字节，累计 `RcvbufErrors=88,907`、`SndbufErrors=216`。这是提高 UDP 缓冲的依据，累计错误不会因调整而归零，应比较后续测试前后的增量。吞吐还取决于运营商路径和客户端网络，不能由参数变化直接推断提速比例。

同日已应用上述优化，Hysteria2 的实际套接字收发缓冲均达到 16 MB。首轮验证包括 7 项 HTTPS 进程测试（45 条断言）、类型检查、构建、mihomo 原生配置校验、三条线路各 3 MB 下载，以及三个 TCP 端点提供的新证书校验。后续补充故障转移及服务器直连规则测试，共 10 项、56 条断言通过。下载复测前后服务端 UDP 缓冲丢包计数均无增加；实际公网吞吐见下方专项测试。

另已修复 `80/tcp` 被防火墙阻挡导致的自动续期失败，并实际完成续期：新证书有效至 2026-11-09 12:39（Asia/Singapore），三个 TCP 端点和新建 Hysteria2 连接均已验证，原 cron 保留且可正常跳过新证书。续期验证结束后 80 端口无监听。本次改造前的旧配置及旧证书备份已按要求删除，正在使用的证书及 acme.sh 配置保留。

## 带宽与丢包对照实测（2026-11-02）

正式测试时间：22:14–22:16，Asia/Singapore。同一台 VPS 上运行两个临时 Hysteria2 v2.13.0 实例，复制线上配置，使用独立测试凭证；客户端为 mihomo v1.19.32，固定从 `en1` 出站。数据源位于 VPS 本机，排除外部 CDN 路径；下表测量的是电脑到 VPS 的隧道有效吞吐。

通过复制临时进程的 UDP 文件描述符，仅调整测试套接字的收发缓冲：旧配置的实际值为 425,984 字节，新配置为 16,777,216 字节。旧配置请求值为 212,992；Linux 对 `SO_RCVBUF` / `SO_SNDBUF` 的设置值翻倍后返回，见 [socket(7)](https://man7.org/linux/man-pages/man7/socket.7.html)。全局参数保持优化后的值，线上三个服务的 PID 全程不变。

每轮交替顺序；第三轮交换两个实例的缓冲档位，减小端口或路径差异的影响。单流下载、上传各 5 轮，每次 20 MiB；四流下载各测 1 轮，每流 20 MiB。每个配置总计约 280 MiB，有效载荷等量；所有 28 个传输请求均完成并返回 HTTP 200。

| 指标 | 旧缓冲 | 新缓冲 | 本轮变化 |
| --- | ---: | ---: | ---: |
| 单连接下载中位数，5 轮 | 78.8 Mbps | 93.6 Mbps | +18.8% |
| 单连接上传中位数，5 轮 | 63.6 Mbps | 75.0 Mbps | +17.9% |
| 四连接下载，1 轮 | 169.0 Mbps | 128.7 Mbps | -23.8% |
| 测试套接字接收缓冲丢包 | 4,289 包 | 0 包 | 本轮新缓冲无溢出 |
| 各档位测试期间系统发送缓冲错误增量 | 10 | 0 | 系统级统计，非单套接字归属 |

接收缓冲丢包的改善在交换实例后仍随“小缓冲”出现，全机 `RcvbufErrors` 增量也恰为 4,289。线上 `2096/udp` 套接字的丢包计数仍为 0；这次全机累计计数增加来自隔离测试实例。单连接下载 5 对样本中 4 对更快，上传 3 对更快；配对提升中位数分别为 11.0% 和 5.0%，与上表“吞吐中位数之比”统计口径不同。样本较少，配对提升的 bootstrap 95% 区间跨过 0，不能据此承诺持续或全场景提速；四流仅 1 轮，尚未证实改善。

另外用约 1 KB 的 UDP 探测包在 20 包/秒下统计服务端实际收到、发出和客户端收到的序列号。后续检查发现，这部分探测未绑定物理网卡，当时本机 TUN 已启用；以下为包含 TUN 处理的历史结果，不能作为裸公网路径的丢包率：

| 场景 | 去程未收到 | 回程未收到 | UDP RTT 中位数 |
| --- | ---: | ---: | ---: |
| 带宽测试期间，1,283 个探测包 | 6.7%（86 包） | 15.6%（187 / 1,197 包） | 74.4 ms |
| 空载，200 个探测包 | 0%（0 包） | 14.0%（28 包） | 73.6 ms |

ICMP 探测分别为 100 发 65 收（5 包/秒）和 20 发 13 收（1 包/秒），均为 35% 未收到回复；这部分也没有隔离 TUN。它们既不能证明运营商回程丢包 14%，也不等于 QUIC 业务包丢失率。服务器接收缓冲优化能减少已测出的套接字溢出，不能保证整条链路零丢包。

首次公网 Cloudflare 3 MB 下载样本为 Hysteria2 4.84 Mbps、Vision 7.27 Mbps、WebSocket 6.96 Mbps，三者均完成并校验证书。这是早期短样本，后续使用 20 MB 公网文件及真实客户端重新测量；两种测试不能直接合并计算提速比例。

正式对照消耗约 560 MiB 有效载荷，另有预算提前结束的约 267 MiB 试测和 9 MB 公网样本。正式数据、每轮数值、端口交叉后的缓冲验证及清理结果见 [脱敏测试记录](docs/performance-2026-11-02.json)。旧基线重放脚本、两次启动失败记录、试测明细、临时实例及防火墙规则均已清理；正式测试统计保留。

## 公网下载优化验收（2026-11-02）

本轮改用真实公网 HTTPS 文件，并通过这台 Mac 正在使用的 Clash 验收。VPS 直接下载 Cloudflare 5 MB / 20 MB 分别为 225.8 / 348.9 Mbps，Node.js 5 MB 为 247.2 Mbps，说明不能将本地代理的低速直接归因于 VPS 公网端口带宽。

已将客户端从按延迟选线的「自动选择」切到「故障转移」，优先 Hysteria2；刷新本 VPS 订阅，确认首项服务器直连规则、60 秒检查及失败阈值 2 已生效。TUN 保持开启，并在客户端仅排除本 VPS 的单个 `/32` 地址。最终下载期间通过核心连接 API 确认实际路径为「节点选择 → 故障转移 → wr-vps-hy2」，公网文件均验证 TLS，返回字节数与请求一致。

| 最终真实客户端下载 | 大小 | 吞吐 | 折合下载速度 |
| --- | ---: | ---: | ---: |
| Cloudflare，HTTP 代理 | 80 MB | 61.8 Mbps | 7.7 MB/s |
| Node.js，HTTP 代理 | 50 MB | 77.2 Mbps | 9.7 MB/s |
| Cloudflare，仅 TUN，显式禁用 HTTP 代理 | 20 MB | 65.5 Mbps | 8.2 MB/s |

短文件结果仍有波动：最终订阅刷新后的三轮 20 MB 下载，Cloudflare 为 16.1–41.1 Mbps，中位数 33.7；Node.js 为 24.1–46.8 Mbps，中位数 37.3。此前实际客户端的两轮自动网卡测试达到 68.0–99.1 Mbps。这些结果与上表一起保留，不能只取最快一次承诺恒定带宽。最终三轮 20 MB 测试期间，Mac 全机 UDP 接收缓冲溢出计数增量为 0；这是缓冲统计，不代表整条公网零丢包。

为避免调参反而限速，以下候选方案经对照后均未保留：

- 固定 Hysteria2 下载 90 Mbps：三个交替轮次的 20 MB 公网下载中位数为 63.5 / 64.2 Mbps，自动拥塞控制为 73.5 / 91.3 Mbps。
- 服务端激进 BBR：两轮 20 MB 下载中位数为 78.9 / 78.6 Mbps，同轮默认 BBR 为 96.9 / 101.0 Mbps；临时服务已删除，生产配置未改为激进模式。
- Mac UDP 默认接收缓冲从 786,896 调至 4,194,304 字节：三组交叉复测没有重复证明提速，两档测试期间全机缓冲溢出增量均为 0，已恢复 Mac 原值。VPS 的 16 MB 缓冲优化保留。
- 固定本机出站网卡 `en1`：实际客户端没有测出优于自动选择的结果，已恢复客户端原配置，避免影响以后切换网络。

独立客户端对照阶段为 mihomo v1.19.32，最终实际客户端核心为 v1.19.33；不同阶段、文件大小和客户端状态的数字不应合并成单项调参的提速百分比。详细请求、失败样本、交叉顺序、证书校验及清理结果保存在 [公网下载脱敏记录](docs/public-download-2026-11-02.json)。临时测试凭证、配置、部署回滚文件和新增测试防火墙规则已清理，仓库仅保留脱敏结果。

## 安全注意

- `SUB_SECRET`、WS path、UUID、`HY2_AUTH`、`HY2_OBFS`、服务器地址均为凭证，仓库内只有占位符；真实值放 `.env`（已 gitignore）。
- 服务器上真实值在 `/usr/local/bin/.env`、`/usr/local/etc/xray/config.json` 与 `/etc/hysteria/config.yaml`，不要提交。
- 代理与订阅服务均以独立非 root 用户运行，服务不可写配置及 TLS 密钥（见服务模板）。
- 链接等同代理凭证。现已通过应用 ACL 和 UFW 出站规则禁止代理账户访问本机、内网和元数据；不应把链接交给不可信的人。
- SSH 只允许公钥认证，保留两把经用户确认的公钥。代理客户端应将 VPS 管理地址设为直连；经代理回连 VPS 的 SSH 端口会被拒绝。
- [2026-11-03 安全核验](docs/security-hardening.md)记录了隔离实测、权限变更及重启后的新内核核验。

## 安全加固

防火墙、补丁、SSH 与降权的分阶段方案、验收口径和实测记录见
`docs/security-hardening.md`。要点：

- 入站白名单为 `80/tcp`（证书续期）、`443/tcp`、`2053/tcp`、`8443/tcp`、`2096/udp`、`65455/tcp`；
  增减端口时同步 `ufw` 与本文档；
- SSH 仅公钥登录（`PasswordAuthentication no`，当前强制仅公钥的 drop-in 在 `/etc/ssh/sshd_config.d/00-vless-key-only.conf`）；
- `fail2ban` 的 `sshd` jail 必须覆盖 `journalmatch = _SYSTEMD_UNIT=ssh.service + _COMM=sshd`。
  默认值是 `sshd.service`，而 Ubuntu 的 unit 名是 `ssh.service`，不覆盖会**静默不生效**
  （`status` 显示 running 但永远抓不到事件）。
