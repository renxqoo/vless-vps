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
| `src/vless-sub-server.ts` | Bun 订阅服务：多节点列表、节点选择/自动选择分组、国内直连规则、流量展示 |
| `deploy/vless-url` | 服务器换号脚本：生成新 UUID → 热替换 → 旧 URL 立即失效，失败自动回滚 |
| `deploy/vless-sub.service.example` | systemd 单元模板（占位符见内文） |
| `deploy/xray-config.example.json` | Xray 配置模板（443 Vision + 2053 WS） |
| `deploy/hysteria-config.example.yaml` | Hysteria2 服务端配置模板（2096 QUIC + salamander 混淆） |
| `deploy/hysteria.service.example` | Hysteria2 systemd 单元模板 |
| `.env.example` | 环境变量清单 |

## 配置

服务启动时先读同目录 `.env`（已存在的环境变量优先），必填：

- `VLESS_HOST` 服务器 IP 或域名
- `SUB_SECRET` 订阅路径密钥
- `WS_PATH` WebSocket 路径

可选（端口、证书路径、网卡、流量总额度）见 `.env.example`。

Hysteria2 节点由三个变量控制：`HY2_AUTH` 留空则订阅里不出现该节点；填入后需与 `/etc/hysteria/config.yaml` 的 `auth.password` 一致。`HY2_OBFS` 对应 `obfs.salamander.password`，两边必须相同，留空则不加混淆。

## 部署要点

1. Xray 官方脚本安装；证书用 acme.sh `--certificate-profile shortlived` 签 IP 证书（Let's Encrypt，6 天有效期，ARI 自动排期续期），`--install-cert --reloadcmd "chown xray:xray /etc/xray-certs/*; chmod 600 /etc/xray-certs/*; systemctl restart xray; systemctl restart hysteria; systemctl restart vless-sub"` 挂钩热加载，三个服务共用同一份证书。`vless-sub` 只在启动时 `readFileSync` 证书并交给 `createServer`，不重启就会一直用旧证书，续期后订阅端点会返回过期证书导致客户端拉订阅失败，所以钩子里必须包含它。
2. Bun 装在 `/root/.bun/bin/bun`；服务器运行 `bun run /usr/local/bin/vless-sub-server.js`（`bun build` 产物，`deploy:build` 一键推进）；密钥在 `WorkingDirectory` 的 `.env`。
3. 流量统计依赖 `vnstat`（接口名 `NET_IF`）。
4. 换号：服务器执行 `vless-url`，输出新分享链接和订阅地址；客户端更新订阅即可。Hysteria2 用密码认证，不受 UUID 换号影响。
5. Hysteria2 安装：下载 `hysteria-linux-amd64` 到 `/usr/local/bin/hysteria`，按 `deploy/hysteria-config.example.yaml` 写 `/etc/hysteria/config.yaml`（600，`root` 所有但属组可读时用 `root:xray` + `0640`，因为服务以 `xray` 用户运行），用 `deploy/hysteria.service.example` 建 unit 并 `systemctl enable --now hysteria`。
6. 证书与密钥在 `/etc/xray-certs/`，属主 `xray:xray`、权限 600；`hysteria.service` 以 `xray` 用户运行以便读取。

## 安全注意

- `SUB_SECRET`、WS path、UUID、`HY2_AUTH`、`HY2_OBFS`、服务器地址均为凭证，仓库内只有占位符；真实值放 `.env`（已 gitignore）。
- 服务器上真实值在 `/etc/systemd/system/vless-sub.service`、`/usr/local/bin/.env`、`/usr/local/etc/xray/config.json` 与 `/etc/hysteria/config.yaml`，不要提交。
