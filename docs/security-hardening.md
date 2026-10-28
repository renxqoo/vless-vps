# 服务器安全加固方案

> 状态：定稿
> 级别：中（命中「不可逆存量变更」判据：防火墙上线、SSH 认证策略、系统包升级均可导致失联或服务中断）
> 日期：2026-10-29

## 背景

一次只读安全审计的结果。审计未发现入侵痕迹（登录记录仅本人两个出口 IP、无额外用户、
无异常进程、cron 仅 acme.sh），但存在下列待修项，按风险排序：

| 项 | 审计现状 | 风险 |
| --- | --- | --- |
| 安全补丁 | `apt list --upgradable` 共 302 项，其中 187 项标 security；内核停留 `6.8.0-48-generic` | 高 |
| 防火墙 | `iptables -S` 三条策略全 ACCEPT，`ufw` inactive | 高 |
| SSH | `PermitRootLogin yes` + `PasswordAuthentication yes`，无 fail2ban，仅靠非标端口 65455 遮蔽 | 中高 |
| `vless-sub` 权限 | `User=root`，对一个只读配置的 HTTP 服务而言过宽 | 中 |
| 证书/密钥权限 | `.env` 600、hysteria 配置 640、私钥 600、authorized_keys 600 | 无需变动 |

## 契约

本次不改动任何对外协议、端口语义或订阅输出格式。受影响的对外契约仅限
「谁可以连进来」：

- 入站可达面从「全部 ACCEPT」收敛为白名单：`443/tcp`、`2053/tcp`、`2096/udp`、`65455/tcp`；
- SSH 认证方式从「公钥 + 密码」收敛为「仅公钥」（`PermitRootLogin` 与端口均不变）；
- 订阅端点 `https://<HOST>:8443/<SECRET>/sub` 的路径、响应头、YAML/base64 两种形态完全不变。

副作用时序：每条规则启用后立即可观测（新连接尝试 / 服务状态 / 订阅响应）。

## 问题域

处理：

- 安装待装的安全更新（不重启主机、不自动重启服务）
- 启用入站白名单防火墙
- 为 SSH 增加爆破限速
- 关闭 SSH 密码登录
- 将 `vless-sub` 降权至 `xray` 用户
- 消除 `vless-sub` 密钥的双轨存放

不处理（各归属）：

- **xray 的 `fallbacks` / 站点伪装**：改变 443 的探测形态，属可用性（抗识别）而非本次安全项，
  归属「后续独立批次」。本次不动，避免与加固同批形成难定位的复合故障。
- **订阅 URL 的一次性凭证化与限速**：涉及订阅协议变更，归属「另立需求」。
- **重启用新内核**：需停机，归属「用户择机执行」；本次只安装不重启。
- **改 SSH 端口 / 换域名**：现存配置已是非标端口，不在本次范围。
- **Clash Verge TUN 相关**：已由用户自行解决，不在本次范围。

## 并发/一致性预算

- `apt upgrade` 期间不得自动重启任何服务：`needrestart` 已安装，必须显式置为仅列出模式。
- 防火墙启用后保留一条「定时自动回滚」看门狗（无 `at` 命令，用 `nohup` + `sleep` 后台进程），
  验证通过后立即销毁；窗口 300s。
- 降权后服务重启的不可用窗口应 ≤ 5s（systemd `Restart=on-failure`，单进程无状态服务）。

## 拆分

| 层 | 变更 |
| --- | --- |
| 包管理 | 安装 security 更新；新增 `fail2ban` |
| 内核防火墙 | `ufw` 白名单 |
| SSH | `sshd_config` 关闭密码认证；fail2ban jail |
| systemd | `vless-sub.service` 的 `User`/`Group`/`Environment`/`ReadOnlyPaths`/`ReadWritePaths` |
| 文件权限 | `/usr/local/bin/.env` → `root:xray 0640`；bun 可执行文件移出 `/root` |
| 仓库 | 同步 `deploy/vless-sub.service.example`、README |

## 实施顺序

每阶段独立可回滚，且下一阶段开始前必须通过本阶段验收点。

**阶段 0 — 基线快照**
备份 `sshd_config`、`vless-sub.service`、`.env`、现有 iptables 规则到 `/root/hardening-backup-<ts>/`。
验收：备份文件存在且可读。

**阶段 1 — 安全更新**
`apt-get update` → `apt-get -y -o Dpkg::Options::=--force-confold upgrade`，
环境变量 `DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l`。
验收：升级返回 0；`xray`/`hysteria`/`vless-sub` 三个 unit 仍 active；订阅端点仍 200；
代理实测仍可出网。**不重启主机**。

**阶段 2 — 防火墙**
先 `ufw allow 65455/tcp`、`443/tcp`、`2053/tcp`、`2096/udp`，再挂看门狗，
最后 `ufw --force enable`；`ufw default deny incoming` / `allow outgoing`。
验收：从**全新 SSH 连接**验证可登录；三个服务端口对外可达；订阅 200；销毁看门狗。

**阶段 3 — fail2ban**
`sshd` jail（`maxretry=5`、`findtime=10m`、`bantime=1h`），`backend=systemd`。
验收：`fail2ban-client status sshd` 为 running；服务 enabled；SSH 仍可登录。

**阶段 4 — 关闭 SSH 密码认证**
先以 `BatchMode=yes` 证明仅公钥可登录，再置 `PasswordAuthentication no`，
`sshd -t` 校验后 reload（不断开现有会话）。
验收：新连接仅公钥可登录；密码登录被拒（`Permission denied (publickey)`）。

**阶段 5 — vless-sub 降权**
前置：`/root` 为 700，`xray` 无法执行 `/root/.bun/bin/bun`，因此先把 bun 安装或复制到
`/usr/local/bin/bun`（属主 root、0755）；`.env` 改 `root:xray 0640`；
单元改 `User=xray`/`Group=xray`，删除重复的 `Environment=SUB_SECRET`/`WS_PATH`
（`.env` 为唯一来源），`ReadOnlyPaths=/usr/local/etc/xray /etc/xray-certs`，
删除 `ReadWritePaths=/etc/xray-certs`（服务只读证书）。
验收：`systemctl show -p User` 为 xray；订阅 200 且三节点齐全；日志无权限错误。

**阶段 6 — 收口**
四门 + 验收清单逐项 + 对抗审查。

## 裁决

- **防火墙工具选 `ufw`**（默认裁决）：已安装，语义清晰，规则少；不用裸 iptables 脚本。
- **不重启主机**（默认裁决）：内核更新留待用户择机，避免把「安全加固」和「停机重启」
  绑成一次不可分割的高风险操作。
- **保留 `PermitRootLogin yes`**（默认裁决）：仅关闭密码认证即可消除风险，
  同时避免因 `prohibit-password` 与 `yes` + `PasswordAuthentication no` 的叠加工语义
  变化带来意外失联。
- **订阅端点为纯读服务，降权到 `xray`**（默认裁决）：它与 xray 共用同一份配置与证书，
  复用既有用户比新建用户更少一处权限面。
- **密钥单一真相落 `.env`**（默认裁决）：单元里的 `Environment=` 与 `.env` 内容重复，
  属双轨；保留 `.env`（可随服务一起备份/轮换），删除单元内重复项。

## 测试口径

本次为运维变更，四门映射为：`typecheck`→仓库 `bun run typecheck`（仅阶段 5 触及仓库产物）、
`lint`→无独立 lint 配置，以 `bash -n` / `sshd -t` / `systemctl cat` 语法校验代替、
`build`→`bun run build`、`test`→运行时契约验证。

**契约级（每阶段必跑，表驱动）**

| 检查 | 期望 | 判据来源 |
| --- | --- | --- |
| `systemctl is-active xray hysteria vless-sub` | 三者皆 `active` | 服务契约 |
| `curl -sk -A clash-verge https://127.0.0.1:8443/<SECRET>/sub` | 含 `wr-vps-hy2`/`wr-vps-vision`/`wr-vps-ws` | 订阅契约 |
| 公网 `curl https://<HOST>:8443/.../sub`（校验证书） | `http=200` 且 `ssl_verify_result=0` | TLS 契约 |
| `curl -x 127.0.0.1:7897 cdn-cgi/trace` | `ip=103.248.228.194` | 代理数据面 |
| `ssh wr`（BatchMode） | 成功 | 可达性契约 |

**边界与异常**

- 未列入白名单的端口必须不可达：`nmap`/`nc` 探测 `22`、`3306`、`6379` 应超时或拒绝。
- 白名单端口从外部必须可达（不只本机 loopback）。
- 密码登录必须被拒：`ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no`。
- 降权后 `xray` 用户对 `/usr/local/bin/.env` 可读、对 `/root` 不可读（越权矩阵一条）。

**隔离/权限面（阶段 5 强制）**

| 主体 | 资源 | 期望 |
| --- | --- | --- |
| `xray` | `/usr/local/bin/.env` | 可读 |
| `xray` | `/usr/local/etc/xray/config.json` | 可读 |
| `xray` | `/etc/xray-certs/privkey.pem` | 可读 |
| `xray` | `/root/**` | 不可读不可执行 |
| 其他 | `/usr/local/bin/.env` | 不可读 |

**回归**

- 阶段 1 后：代理吞吐实测一次，与审计前同量级（排除 `apt` 引入的库级回归）。
- 阶段 5 后：订阅输出与阶段 0 备份逐字节比对（除时间戳/流量数字外应一致）。

## 验收清单

- [ ] 阶段 0 备份完整
- [ ] 阶段 1 安全更新完成，`apt list --upgradable` 中 security 项归零
- [ ] 阶段 2 ufw 白名单生效，未列端口不可达，SSH 可登录
- [ ] 阶段 3 fail2ban 运行且 enabled
- [ ] 阶段 4 密码登录被拒，公钥登录可用
- [ ] 阶段 5 `vless-sub` 以 `xray` 运行，订阅输出不变
- [ ] 越权矩阵五条逐条验证
- [ ] 三个服务全程 `active`，代理数据面全程可用
- [ ] 仓库 `deploy/vless-sub.service.example` 与 README 同步
- [ ] 对抗审查问题清零
- [ ] 如实报告：未完成项（内核重启）与遗留项
