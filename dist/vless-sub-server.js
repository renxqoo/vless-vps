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
var HY2_PORT = Number(process.env.HY2_PORT ?? 2096);
var HY2_AUTH = process.env.HY2_AUTH ?? "";
var HY2_OBFS = process.env.HY2_OBFS ?? "";
var NET_IF = process.env.NET_IF ?? "ens17";
var TOTAL_BYTES = Number(process.env.TOTAL_BYTES ?? 200 * 1024 * 1024 * 1024);
var SECRET = process.env.SUB_SECRET ?? "";
var WS_PATH = process.env.WS_PATH ?? "";
if (!HOST || !SECRET || !WS_PATH) {
  console.error("missing required env: VLESS_HOST / SUB_SECRET / WS_PATH");
  process.exit(1);
}
var NODE_VISION = "wr-vps-vision";
var NODE_WS = "wr-vps-ws";
var NODE_HY2 = "wr-vps-hy2";
var HY2_ENABLED = HY2_AUTH !== "";
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
function hy2Url(name) {
  if (!HY2_ENABLED)
    return null;
  const q = new URLSearchParams({ sni: HOST, insecure: "0" });
  if (HY2_OBFS) {
    q.set("obfs", "salamander");
    q.set("obfs-password", HY2_OBFS);
  }
  return `hysteria2://${encodeURIComponent(HY2_AUTH)}@${HOST}:${HY2_PORT}?${q.toString()}#${encodeURIComponent(name)}`;
}
function shareLinks(uuid) {
  return [
    hy2Url(NODE_HY2),
    vlessUrl(uuid, NODE_VISION, VLESS_PORT, false),
    vlessUrl(uuid, NODE_WS, WS_PORT, true)
  ].filter((link) => link !== null);
}
function fmtGb(bytes) {
  return (bytes / 1024 / 1024 / 1024).toFixed(2);
}
function visionProxy(uuid) {
  return `  - name: "${NODE_VISION}"
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
      - http/1.1`;
}
function wsProxy(uuid) {
  return `  - name: "${NODE_WS}"
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
      - http/1.1`;
}
function hy2Proxy() {
  if (!HY2_ENABLED)
    return "";
  const obfs = HY2_OBFS ? `
    obfs: salamander
    obfs-password: ${HY2_OBFS}` : "";
  return `  - name: "${NODE_HY2}"
    type: hysteria2
    server: ${HOST}
    port: ${HY2_PORT}
    password: ${HY2_AUTH}
    sni: ${HOST}
    skip-cert-verify: false${obfs}`;
}
function nodeNames() {
  const names = [NODE_HY2, NODE_VISION, NODE_WS];
  return HY2_ENABLED ? names : names.filter((name) => name !== NODE_HY2);
}
function clashYaml(uuid, up, down) {
  const usage = `\uD83D\uDCCA \u672C\u6708\u5DF2\u7528\uFF1A${fmtGb(up + down)} GB`;
  const proxies = [hy2Proxy(), visionProxy(uuid), wsProxy(uuid)].filter((block) => block !== "").concat(`  - { name: "${usage}", type: trojan, server: 127.0.0.1, port: 1, password: info, udp: false }`).join(`

`);
  const nodes = nodeNames().join(", ");
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
${proxies}

proxy-groups:
  - name: \u8282\u70B9\u9009\u62E9
    type: select
    proxies: [\u81EA\u52A8\u9009\u62E9, ${nodes}, "${usage}", DIRECT]
  - name: \u81EA\u52A8\u9009\u62E9
    type: url-test
    proxies: [${nodes}]
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
  return Buffer.from(shareLinks(uuid).join(`
`), "utf8").toString("base64");
}
function vnstatBytes() {
  const out = execFileSync("/usr/bin/vnstat", ["--json", "m", "1", "-i", NET_IF], {
    encoding: "utf8",
    timeout: 5000
  });
  const month = JSON.parse(out).interfaces?.[0]?.traffic?.month?.[0];
  if (!month)
    return null;
  return { up: month.rx ?? 0, down: month.tx ?? 0 };
}
function procNetDevBytes() {
  for (const line of readFileSync("/proc/net/dev", "utf8").split(`
`)) {
    const m = line.match(/^\s*([a-z0-9]+):\s+(\d+)\s+(?:\d+\s+){7}(\d+)/);
    if (m && m[1] === NET_IF) {
      return { up: Number(m[2]), down: Number(m[3]) };
    }
  }
  return null;
}
function trafficBytes() {
  for (const read of [vnstatBytes, procNetDevBytes]) {
    try {
      const bytes = read();
      if (bytes)
        return bytes;
    } catch {}
  }
  return { up: 0, down: 0 };
}
var server = createServer({ cert: readFileSync(CERT), key: readFileSync(KEY) }, (req, res) => {
  try {
    serve(req.url, req.headers["user-agent"], res);
  } catch (error) {
    console.error("subscription request failed", error);
    if (!res.headersSent) {
      res.writeHead(500).end();
    }
  }
});
function serve(pathname, userAgent, res) {
  const url = new URL(pathname ?? "/", `https://${HOST}`);
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
  const ua = (userAgent ?? "").toLowerCase();
  if (url.pathname.endsWith("/vless")) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(shareLinks(uuid).join(`
`) + `
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
}
server.listen(PORT, "0.0.0.0");
