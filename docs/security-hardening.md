# 服务器安全加固方案

> 状态：已实施
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

- 入站可达面从「全部 ACCEPT」收敛为白名单：`443/tcp`、`2053/tcp`、`8443/tcp`、`2096/udp`、`65455/tcp`；
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
先 `ufw allow 65455/tcp`、`443/tcp`、`2053/tcp`、`8443/tcp`、`2096/udp`，再挂看门狗，
最后 `ufw --force enable`；`ufw default deny incoming` / `allow outgoing`。
验收：从**全新 SSH 连接**验证可登录；三个服务端口对外可达；订阅 200；销毁看门狗。

白名单必须包含 `8443/tcp`（订阅端点），否则客户端拉不到订阅——这是起草时漏掉、
复核监听面时补回的一项。`40823/udp` 是 hysteria 的出站 UDP 套接字，依赖
`default allow outgoing` + conntrack 回包，不单独放行；启用后用隧道内 UDP 请求验证，
若失败再补规则并在此处记录。

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

## 实施记录

偏差与实测结果（方案草稿与实际执行的差异均在此记录）：

| 阶段 | 结果 | 备注 |
| --- | --- | --- |
| 0 | ✓ | `/root/hardening-backup-20261028-170719/`。`iptables.rules` 为 0 字节是准确的——当时只有 3 条策略行、无实际规则 |
| 1 | ✓ | 295 包升级退出 0。升级过程中 SSH 会话短暂中断（libssl/openssh/apparmor 替换），自行恢复。**security 项归零**，新内核 `6.8.0-147` 已装但未生效 |
| 2 | ✓ | 白名单 5 条（含起草时遗漏的 8443）。外部实测：8443 从伊朗/瑞典/美国三地可达；22 从奥地利/瑞士/美国三地超时 |
| 3 | ✓ | 修复了 `journalmatch` 默认值与 Ubuntu unit 名不符的陷阱，实测能捕获失败并真落 `ufw` REJECT 规则 |
| 4 | ✓ | 密码登录返回 `Permission denied (publickey)`，方法列表中已无 password |
| 5 | ✓ | 进程用户 `xray`；订阅输出与阶段 0 备份仅差流量数字（15.15→15.40 GB） |

阶段 1 执行时的偏差：

- 内核元包被 `apt upgrade` 保留（需 `dist-upgrade` 才装新包）。已用
  `install --only-upgrade linux-generic linux-image-generic linux-headers-generic` 单独安装。
- `linux-firmware` 仍待升级，但它非 security 项，且虚拟机无需固件驱动——按「只处理授权范围内、最小充分改动」跳过，在此登记。

`needrestart` 被置为 `NEEDRESTART_MODE=l` + `NEEDRESTART_SUSPEND=1`，全程未自动重启任何服务。

阶段 2 执行时的偏差：

- 看门狗用 `nohup` + `sleep 300` 实现（无 `at` 命令），验证通过后 `rm` armed 标记并结束进程。
- 端口可达性最初用本机 `nc -z` 判定，**得出错误结论**：本机 Clash 处于 TUN 模式，会本地伪造 TCP 握手，
  连不存在的 `55555` 端口也返回 succeeded。改用「服务器打自身公网 IP」发现同样无效
  （本地目标走 OUTPUT→LOCAL_IN，不经 INPUT），最终改用第三方外部扫描节点才得到有效结果。
  这条值得记住：**在本机启用 TUN 的前提下，任何本地发起的端口探测都不可信。**

阶段 3 执行时的偏差：

- 默认 `journalmatch = _SYSTEMD_UNIT=sshd.service` 与 Ubuntu 实际的 `ssh.service` 不符，
  会让 fail2ban 静默无效（`status` 显示 running、`Currently failed` 永远 0）。已在
  `jail.local` 覆盖为 `_SYSTEMD_UNIT=ssh.service + _COMM=sshd`，并用真实失败登录验证捕获生效。
- 封禁动作验证使用保留测试地址 `203.0.113.7`，不碰真实 IP；确认 `ufw-user-input` 出现
  REJECT 规则后立即 `unbanip`，规则已清除。

## 对抗审查结果

独立只读会话逐条核查 10 项，发现的问题与处置：

**必须修复——已修**

1. **`deploy:build` 的 `chmod 700` 会让降权后的服务起不来**。审查发现该脚本会把文件改为
   `700 root:root`，而 `xray` 用户读不到 → `Restart=on-failure` 静默崩溃循环。
   已改为 `chown root:root` + `chmod 755`，并加上 `.env` 的 `root:xray 0640` 护栏；
   同时删除已失效的 `deploy:sub`（线上不再保留 `.ts`，它会把无用文件推上去并重启服务）。
2. **fail2ban 会封掉服务器自己**。实测全部 153 次 SSH 成功登录的来源都是
   `103.248.228.194`（经代理回连，sshd 看到的是服务器自身出口），而 fail2ban 已把它记了
   3 次失败。按 `maxretry=5`，再 2 次就把自己封在门外，且只能走服务商控制台恢复。
   已加 `ignoreip` 含该地址，`mode` 从 `aggressive` 退回 `normal`。
3. **回滚步骤缺失且带优先级陷阱**。方案声称“每阶段可回滚”但未写命令；且只还原
   `sshd_config` 不会恢复密码登录（drop-in 优先生效）。已补「回滚」节。
4. **`.env` 权限漂移会让服务静默挂掉**。已并入 `deploy:build` 护栏与本文档。

**审查纠正了我的一个错误判断**

我此前怀疑“xray 和 hysteria 仍跑在升级前的旧 libc 上”。这是错的：
`file /usr/local/bin/xray` 和 `hysteria` 都是 **statically linked (Go)**，`/proc/<pid>/maps`
里根本没有 libc/libssl 映射，它们不受系统库升级影响。vless-sub（bun，动态链接）在升级后
已重启，加载的也是新 libc。

但审查同时指出一个真实的补丁缺口（比我原判断更准确）：

```
NEEDRESTART-SVC: cron.service dbus.service serial-getty@ttyS0 systemd-logind.service
                 unattended-upgrades.service vnstat.service
/proc/726 (dbus-daemon)    70 个 deleted 映射（ld.so/libc/libexpat/libgcrypt/libapparmor/libcap）
/proc/736 (systemd-logind) 95 个 deleted 映射（含 libc.so.6、libcrypto.so.3、自身二进制）
```

`systemd-logind`（root）和 `dbus-daemon` 仍在跑旧 `libc` / `libcrypto` / `libexpat`，
即安全补丁**已安装但未生效**。处置见遗留项。

**建议项处置**

- `PermitRootLogin yes` → `prohibit-password`：行为不变（密码认证已关），但去掉
  “以后谁把密码认证改回来，root 密码登录立刻复活”的潜伏开关。
- vless-sub 单元补 `ProtectHome=yes`、`CapabilityBoundingSet=`（清空）、
  `RestrictAddressFamilies=AF_INET AF_UNIX`；`ReadOnlyPaths` 是冗余（真正生效的是
  `ProtectSystem=strict`）。
- 清理 `/tmp/network_script`、`/root/do-*.sh`、`/root/ufw-watchdog.sh`。
- 残留风险（已知不改）：`/etc/xray-certs` 属主 `xray:xray 0755`、私钥 `0600` 属 `xray`，
  所以 `xray` 组本身可替换私钥；vless-sub 与 xray/hysteria 同 UID，后者可被前者 SIGKILL
  （数据面 DoS）。要彻底分开需独立用户，超出本次范围。

## 回滚

备份目录：`/root/hardening-backup-20261028-170719/`（路径也写在 `/root/hardening-backup-path`）。

**先看坑**：`/etc/ssh/sshd_config` 第 12 行是 `Include /etc/ssh/sshd_config.d/*.conf`，
而 OpenSSH 取**首次出现**的值。所以只还原主配置**不会**恢复密码登录——
`10-hardening.conf` 里残留的 `PasswordAuthentication no` 仍然优先。必须按下面顺序：

```bash
B=/root/hardening-backup-20261028-170719

# 1) SSH：先删 drop-in，再还原主配置
rm -f /etc/ssh/sshd_config.d/10-hardening.conf
cp -a "$B/sshd_config" /etc/ssh/sshd_config
sshd -t && systemctl reload ssh

# 2) vless-sub：还原 root 单元（旧单元依赖 /root/.bun/bin/bun，该文件仍在）
cp -a "$B/vless-sub.service" /etc/systemd/system/vless-sub.service
cp -a "$B/sub.env" /usr/local/bin/.env
chown root:root /usr/local/bin/.env && chmod 600 /usr/local/bin/.env
systemctl daemon-reload && systemctl restart vless-sub

# 3) fail2ban
systemctl disable --now fail2ban
#    ！fail2ban 的封禁规则写进 /etc/ufw/user.rules（持久），
#    卸载前必须 ufw status numbered 看一遍并手工删掉残留 reject 规则。

# 4) 防火墙（加固前为 inactive 且无规则）
ufw disable
```

**不可回滚的部分**：295 个包的升级与已安装的内核 `6.8.0-147` 无法回退（备份里
没有 `dpkg --get-selections` 版本快照）。所谓「回滚」只是配置级，包与内核是单向的。

## 验收清单

- [x] 阶段 0 备份完整
- [x] 阶段 1 安全更新完成，`apt list --upgradable` 中 security 项归零
- [x] 阶段 2 ufw 白名单生效，未列端口不可达，SSH 可登录
- [x] 阶段 3 fail2ban 运行且 enabled，且已验证能真捕获与真封禁
- [x] 阶段 4 密码登录被拒，公钥登录可用
- [x] 阶段 5 `vless-sub` 以 `xray` 运行，订阅输出不变
- [x] 越权矩阵五条逐条验证（实际跑了 6 条，含 bun 可执行性）
- [x] 三个服务全程 `active`，代理数据面全程可用
- [x] 仓库 `deploy/vless-sub.service.example` 与 README 同步
- [x] 对抗审查问题清零
- [x] 如实报告：未完成项（内核重启）与遗留项

遗留项（未在本次处理，均已登记归属）：

1. **新内核未生效**：`6.8.0-147` 已安装，运行中仍是 `6.8.0-48`。需重启主机，由用户择机执行。
1b. **`systemd-logind` / `dbus-daemon` 仍跑旧库**：本轮 `libc6`、`libssl3t64`、`libexpat`
   的补丁已安装但在这些进程里未生效（`needrestart -b` 列出）。`systemctl restart dbus systemd-logind`
   可清掉，但会短暂影响会话管理，建议与内核重启一并做。
2. **`linux-firmware` 未升级**：非 security 项，虚拟机无需求。
3. **xray 无 `fallbacks`**：443 对外表现为「TLS 握手成功但无 HTTP 响应」，可被主动探测识别。
   属可用性风险，不在本次范围。
4. **订阅 URL 仍为 bearer 凭证、无速率限制**：需改订阅协议，另立需求。
5. **`/root/do-upgrade.sh`、`/root/do-kernel.sh`、`/root/ufw-watchdog.sh`、备份目录**留在服务器上，确认无需回滚后可清理。
