// @bun
// src/vless-sub-server.ts
import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import { createServer } from "https";
function loadEnv() {
  for (const line of readFileSync(".env", "utf8").split(`
`)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2];
    }
  }
}
loadEnv();
var PORT = Number(process.env.SUB_PORT ?? 8443);
var XRAY_CONFIG = process.env.XRAY_CONFIG ?? "/usr/local/etc/xray/config.json";
var CERT = process.env.CERT_FILE ?? "/etc/xray-certs/fullchain.pem";
var KEY = process.env.KEY_FILE ?? "/etc/xray-certs/privkey.pem";
var HOST = process.env.VLESS_HOST ?? "";
var VLESS_PORT = Number(process.env.VLESS_PORT ?? 443);
var WS_PORT = Number(process.env.WS_PORT ?? 2053);
var NET_IF = process.env.NET_IF ?? "ens17";
var TOTAL_BYTES = Number(process.env.TOTAL_BYTES ?? 200 * 1024 * 1024 * 1024);
var SECRET = process.env.SUB_SECRET ?? "";
var WS_PATH = process.env.WS_PATH ?? "";
if (!HOST || !SECRET || !WS_PATH) {
  console.error("missing required env: VLESS_HOST / SUB_SECRET / WS_PATH");
  process.exit(1);
}
function loadInbounds() {
  const cfg = JSON.parse(readFileSync(XRAY_CONFIG, "utf8"));
  return cfg.inbounds ?? [];
}
function uuidOf(inbounds) {
  for (const ib of inbounds) {
    if (ib.protocol === "vless") {
      const clients = ib.settings?.clients ?? [];
      if (clients.length > 0)
        return clients[0].id;
    }
  }
  return null;
}
function vlessUrl(uuid, name, port, ws) {
  const q = new URLSearchParams(ws ? {
    type: "websocket",
    security: "tls",
    encryption: "none",
    path: WS_PATH,
    host: HOST,
    sni: HOST,
    alpn: "http/1.1",
    fp: "chrome",
    allowInsecure: "0"
  } : {
    type: "tcp",
    security: "tls",
    encryption: "none",
    flow: "xtls-rprx-vision",
    sni: HOST,
    alpn: "h2,http/1.1",
    fp: "chrome",
    allowInsecure: "0"
  });
  return `vless://${uuid}@${HOST}:${port}?${q.toString()}#${encodeURIComponent(name)}`;
}
function fmtGb(bytes) {
  return (bytes / 1024 / 1024 / 1024).toFixed(2);
}
function clashYaml(uuid, up, down) {
  const usage = `\uD83D\uDCCA \u672C\u6708\u5DF2\u7528\uFF1A${fmtGb(up + down)} GB`;
  return `mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
unified-delay: true
tcp-concurrent: true

dns:
  enable: true
  ipv6: false
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  default-nameserver: [223.5.5.5, 119.29.29.29]
  nameserver: ['https://223.5.5.5/dns-query', 'https://doh.pub/dns-query']
  proxy-server-nameserver: [223.5.5.5, 119.29.29.29]

proxies:
  - name: "wr-vps-vision"
    type: vless
    server: ${HOST}
    port: ${VLESS_PORT}
    uuid: ${uuid}
    tls: true
    udp: true
    flow: xtls-rprx-vision
    servername: ${HOST}
    client-fingerprint: chrome
    alpn:
      - h2
      - http/1.1

  - name: "wr-vps-ws"
    type: vless
    server: ${HOST}
    port: ${WS_PORT}
    uuid: ${uuid}
    tls: true
    udp: true
    network: ws
    servername: ${HOST}
    ws-opts:
      path: ${WS_PATH}
      headers:
        Host: ${HOST}
    client-fingerprint: chrome
    alpn:
      - http/1.1

  - { name: "${usage}", type: trojan, server: 127.0.0.1, port: 1, password: info, udp: false }

proxy-groups:
  - name: \u8282\u70B9\u9009\u62E9
    type: select
    proxies: [\u81EA\u52A8\u9009\u62E9, wr-vps-vision, wr-vps-ws, "${usage}", DIRECT]
  - name: \u81EA\u52A8\u9009\u62E9
    type: url-test
    proxies: [wr-vps-vision, wr-vps-ws]
    url: 'http://cp.cloudflare.com'
    interval: 300

rules:
  - GEOIP,LAN,DIRECT,no-resolve
  - GEOSITE,CN,DIRECT
  - GEOIP,CN,DIRECT
  - MATCH,\u8282\u70B9\u9009\u62E9
`;
}
function base64Links(uuid) {
  const links = [
    vlessUrl(uuid, "wr-vps-vision", VLESS_PORT, false),
    vlessUrl(uuid, "wr-vps-ws", WS_PORT, true)
  ];
  return Buffer.from(links.join(`
`), "utf8").toString("base64");
}
function trafficBytes() {
  try {
    const out = execFileSync("/usr/bin/vnstat", ["--json", "m", "1", "-i", NET_IF], {
      encoding: "utf8",
      timeout: 5000
    });
    const month = JSON.parse(out).interfaces?.[0]?.traffic?.month?.[0];
    if (month) {
      return { up: month.rx ?? 0, down: month.tx ?? 0 };
    }
  } catch {
    for (const line of readFileSync("/proc/net/dev", "utf8").split(`
`)) {
      const m = line.match(/^\s*([a-z0-9]+):\s+(\d+)\s+(?:\d+\s+){7}(\d+)/);
      if (m && m[1] === NET_IF) {
        return { up: Number(m[2]), down: Number(m[3]) };
      }
    }
  }
  return { up: 0, down: 0 };
}
var server = createServer({ cert: readFileSync(CERT), key: readFileSync(KEY) }, (req, res) => {
  const url = new URL(req.url ?? "/", `https://${HOST}`);
  if (!SECRET || url.pathname !== `/${SECRET}/sub` && url.pathname !== `/${SECRET}/vless`) {
    res.writeHead(404).end();
    return;
  }
  const uuid = uuidOf(loadInbounds());
  if (!uuid) {
    res.writeHead(500).end();
    return;
  }
  const { up, down } = trafficBytes();
  const userinfo = `upload=${up}; download=${down}; total=${TOTAL_BYTES}; expire=0`;
  const ua = (req.headers["user-agent"] ?? "").toLowerCase();
  if (url.pathname.endsWith("/vless")) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(vlessUrl(uuid, "wr-vps-vision", VLESS_PORT, false) + `
` + vlessUrl(uuid, "wr-vps-ws", WS_PORT, true) + `
`);
    return;
  }
  if (ua.includes("clash") || ua.includes("mihomo") || ua.includes("verge")) {
    res.writeHead(200, {
      "Content-Type": "text/yaml; charset=utf-8",
      "subscription-userinfo": userinfo,
      "profile-update-interval": "1",
      "content-disposition": `attachment; filename*=UTF-8''wr-vps.yaml`
    });
    res.end(clashYaml(uuid, up, down));
  } else {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "subscription-userinfo": userinfo,
      "profile-update-interval": "1"
    });
    res.end(base64Links(uuid));
  }
});
server.listen(PORT, "0.0.0.0");
