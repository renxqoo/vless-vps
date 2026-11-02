// @bun
// src/vless-sub-server.ts
import { readFileSync } from "fs";
import { readFile } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { isIP } from "net";
import { createServer } from "https";
function loadEnv() {
  let contents;
  try {
    contents = readFileSync(".env", "utf8");
  } catch (error) {
    if (error.code === "ENOENT")
      return;
    throw error;
  }
  for (const line of contents.split(/\r?\n/)) {
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
var TRAFFIC_CACHE_TTL_MS = Number(process.env.TRAFFIC_CACHE_TTL_MS ?? 30000);
if (!Number.isFinite(TRAFFIC_CACHE_TTL_MS) || TRAFFIC_CACHE_TTL_MS < 1) {
  throw new Error("TRAFFIC_CACHE_TTL_MS must be a positive number");
}
if (!HOST || !SECRET || !WS_PATH) {
  console.error("missing required env: VLESS_HOST / SUB_SECRET / WS_PATH");
  process.exit(1);
}
var NODE_VISION = "wr-vps-vision";
var NODE_WS = "wr-vps-ws";
var NODE_HY2 = "wr-vps-hy2";
var HY2_ENABLED = HY2_AUTH !== "";
var HOST_IP_VERSION = isIP(HOST);
var HOST_DIRECT_RULE = HOST_IP_VERSION ? `IP-CIDR${HOST_IP_VERSION === 6 ? "6" : ""},${HOST}/${HOST_IP_VERSION === 6 ? 128 : 32},DIRECT,no-resolve` : `DOMAIN,${HOST},DIRECT`;
async function loadInbounds() {
  const cfg = JSON.parse(await readFile(XRAY_CONFIG, "utf8"));
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
    server: ${JSON.stringify(HOST)}
    port: ${VLESS_PORT}
    uuid: ${JSON.stringify(uuid)}
    tls: true
    udp: true
    flow: xtls-rprx-vision
    servername: ${JSON.stringify(HOST)}
    client-fingerprint: chrome
    alpn:
      - h2
      - http/1.1`;
}
function wsProxy(uuid) {
  return `  - name: "${NODE_WS}"
    type: vless
    server: ${JSON.stringify(HOST)}
    port: ${WS_PORT}
    uuid: ${JSON.stringify(uuid)}
    tls: true
    udp: true
    network: ws
    servername: ${JSON.stringify(HOST)}
    ws-opts:
      path: ${JSON.stringify(WS_PATH)}
      headers:
        Host: ${JSON.stringify(HOST)}
    client-fingerprint: chrome
    alpn:
      - http/1.1`;
}
function hy2Proxy() {
  if (!HY2_ENABLED)
    return "";
  const obfs = HY2_OBFS ? `
    obfs: salamander
    obfs-password: ${JSON.stringify(HY2_OBFS)}` : "";
  return `  - name: "${NODE_HY2}"
    type: hysteria2
    server: ${JSON.stringify(HOST)}
    port: ${HY2_PORT}
    password: ${JSON.stringify(HY2_AUTH)}
    sni: ${JSON.stringify(HOST)}
    skip-cert-verify: false${obfs}`;
}
function nodeNames() {
  const names = [NODE_HY2, NODE_VISION, NODE_WS];
  return HY2_ENABLED ? names : names.filter((name) => name !== NODE_HY2);
}
function clashYaml(uuid, up, down) {
  const usage = `\uD83D\uDCCA \u672C\u6708\u5DF2\u7528\uFF1A${fmtGb(up + down)} GB`;
  const proxies = [hy2Proxy(), visionProxy(uuid), wsProxy(uuid)].filter((block) => block !== "").join(`

`);
  const nodes = nodeNames().join(", ");
  return `# ${usage}
mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
unified-delay: true
tcp-concurrent: true

profile:
  store-selected: true

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
    proxies: [\u6545\u969C\u8F6C\u79FB, \u81EA\u52A8\u9009\u62E9, ${nodes}, DIRECT]
  - name: \u81EA\u52A8\u9009\u62E9
    type: url-test
    proxies: [${nodes}]
    url: 'https://www.gstatic.com/generate_204'
    interval: 300
    tolerance: 50
    timeout: 5000
    expected-status: 204
    lazy: true
  - name: \u6545\u969C\u8F6C\u79FB
    type: fallback
    proxies: [${nodes}]
    url: 'https://www.gstatic.com/generate_204'
    interval: 60
    timeout: 5000
    max-failed-times: 2
    expected-status: 204
    lazy: true

rules:
  - ${JSON.stringify(HOST_DIRECT_RULE)}
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
var execFileAsync = promisify(execFile);
async function vnstatBytes() {
  const { stdout } = await execFileAsync("vnstat", ["--json", "m", "1", "-i", NET_IF], {
    encoding: "utf8",
    timeout: 5000
  });
  const month = JSON.parse(stdout).interfaces?.[0]?.traffic?.month?.[0];
  if (!month)
    return null;
  if (![month.rx, month.tx].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    return null;
  }
  return { up: month.rx ?? 0, down: month.tx ?? 0 };
}
async function procNetDevBytes() {
  for (const line of (await readFile("/proc/net/dev", "utf8")).split(`
`)) {
    const m = line.match(/^\s*([^\s:]+):\s+(\d+)\s+(?:\d+\s+){7}(\d+)/);
    if (m && m[1] === NET_IF) {
      return { up: Number(m[2]), down: Number(m[3]) };
    }
  }
  return null;
}
var cachedTraffic = null;
var trafficUpdatedAt = 0;
var trafficRefresh = null;
async function readTraffic() {
  try {
    const bytes = await vnstatBytes();
    if (bytes)
      return bytes;
  } catch {}
  if (cachedTraffic)
    return cachedTraffic;
  try {
    const bytes = await procNetDevBytes();
    if (bytes)
      return bytes;
  } catch {}
  return { up: 0, down: 0 };
}
function refreshTraffic() {
  if (!trafficRefresh) {
    trafficRefresh = readTraffic().then((bytes) => {
      cachedTraffic = bytes;
      trafficUpdatedAt = Date.now();
      return bytes;
    }).finally(() => {
      trafficRefresh = null;
    });
  }
  return trafficRefresh;
}
async function trafficBytes() {
  if (!cachedTraffic)
    return refreshTraffic();
  if (Date.now() - trafficUpdatedAt >= TRAFFIC_CACHE_TTL_MS)
    refreshTraffic();
  return cachedTraffic;
}
var server = createServer({ cert: readFileSync(CERT), key: readFileSync(KEY) }, (req, res) => {
  serve(req.url, req.headers["user-agent"], req.method, res).catch(() => {
    console.error("subscription request failed");
    if (!res.headersSent) {
      res.writeHead(500).end();
    }
  });
});
async function serve(pathname, userAgent, method, res) {
  res.setHeader("Cache-Control", "private, no-store");
  const url = new URL(pathname ?? "/", `https://${HOST}`);
  if (!SECRET || url.pathname !== `/${SECRET}/sub` && url.pathname !== `/${SECRET}/vless`) {
    res.writeHead(404).end();
    return;
  }
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const ua = (userAgent ?? "").toLowerCase();
  const format = url.pathname.endsWith("/vless") ? "links" : url.searchParams.get("format") ?? (["clash", "mihomo", "verge"].some((client) => ua.includes(client)) ? "clash" : "base64");
  if (!["clash", "base64", "links"].includes(format)) {
    res.writeHead(400).end(`format must be clash, base64 or links
`);
    return;
  }
  const uuid = uuidOf(await loadInbounds());
  if (!uuid) {
    res.writeHead(500).end();
    return;
  }
  if (format === "links") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(method === "HEAD" ? undefined : shareLinks(uuid).join(`
`) + `
`);
    return;
  }
  const { up, down } = await trafficBytes();
  const userinfo = `upload=${up}; download=${down}; total=${TOTAL_BYTES}; expire=0`;
  if (format === "clash") {
    res.writeHead(200, {
      "Content-Type": "text/yaml; charset=utf-8",
      "subscription-userinfo": userinfo,
      "profile-update-interval": "1",
      "content-disposition": `attachment; filename*=UTF-8''wr-vps.yaml`
    });
    res.end(method === "HEAD" ? undefined : clashYaml(uuid, up, down));
  } else {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "subscription-userinfo": userinfo,
      "profile-update-interval": "1"
    });
    res.end(method === "HEAD" ? undefined : base64Links(uuid));
  }
}
server.listen(PORT, "0.0.0.0");
