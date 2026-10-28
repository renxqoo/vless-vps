# vless-vps

自建 VLESS 代理：Xray + Let's Encrypt IP 证书（6 天短效，acme.sh 自动续期）+ Bun 订阅服务 + 换号脚本。

## 架构

```
客户端 (Clash Verge / mihomo)
   │
   ├─ 443  Xray VLESS + Vision (TLS 1.3)
   ├─ 2053 Xray VLESS + WebSocket（备用线路）
   │
   └─ 8443 Bun 订阅服务（本文档的 src/vless-sub-server.ts）
          ├─ /<secret>/sub    按 User-Agent 返回 Clash YAML / base64 节点列表
          ├─ /<secret>/vless  返回 vless:// 分享链接
          └─ subscription-userinfo 响应头 = vnstat 月流量
```

## 组成

| 路径 | 说明 |
|---|---|
| `src/vless-sub-server.ts` | Bun 1.4.4 订阅服务：多节点列表、节点选择/自动选择分组、国内直连规则、流量展示 |
| `deploy/vless-url` | 服务器换号脚本：生成新 UUID → 热替换 → 旧 URL 立即失效，失败自动回滚 |
| `deploy/vless-sub.service.example` | systemd 单元模板（占位符见内文） |
| `deploy/xray-config.example.json` | Xray 配置模板（443 Vision + 2053 WS） |

## 部署要点

1. Xray 官方脚本安装；证书用 acme.sh `--certificate-profile shortlived` 签 IP 证书（Let's Encrypt，6 天有效期，ARI 自动排期续期），`--install-cert --reloadcmd "systemctl restart xray"` 挂钩热加载。
2. Bun 装在 `/root/.bun/bin/bun`；`vless-sub.service` 通过 `Environment=SUB_SECRET= / WS_PATH=` 注入密钥。
3. 流量统计依赖 `vnstat`（接口名见 `NET_IF`）。
4. 换号：服务器执行 `vless-url`，输出新 vless:// 链接和订阅地址；客户端更新订阅即可。

## 安全注意

- `SUB_SECRET`（订阅路径）、WS path、UUID 均为凭证，入库前已替换为占位符。
- 服务器上真实值在 `/etc/systemd/system/vless-sub.service` 与 `/usr/local/etc/xray/config.json`，不要提交。

## 本地开发

```bash
bun run src/vless-sub-server.ts   # 需要环境变量 SUB_SECRET / WS_PATH 与证书文件
```
