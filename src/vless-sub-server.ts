import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { ServerResponse } from "node:http";
import { createServer } from "node:https";

function loadEnv(): void {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2];
    }
  }
}

loadEnv();

const PORT = Number(process.env.SUB_PORT ?? 8443);
const XRAY_CONFIG = process.env.XRAY_CONFIG ?? "/usr/local/etc/xray/config.json";
const CERT = process.env.CERT_FILE ?? "/etc/xray-certs/fullchain.pem";
const KEY = process.env.KEY_FILE ?? "/etc/xray-certs/privkey.pem";
const HOST = process.env.VLESS_HOST ?? "";
const VLESS_PORT = Number(process.env.VLESS_PORT ?? 443);
const WS_PORT = Number(process.env.WS_PORT ?? 2053);
const HY2_PORT = Number(process.env.HY2_PORT ?? 2096);
const HY2_AUTH = process.env.HY2_AUTH ?? "";
const HY2_OBFS = process.env.HY2_OBFS ?? "";
const NET_IF = process.env.NET_IF ?? "ens17";
const TOTAL_BYTES = Number(process.env.TOTAL_BYTES ?? 200 * 1024 * 1024 * 1024);
const SECRET = process.env.SUB_SECRET ?? "";
const WS_PATH = process.env.WS_PATH ?? "";

if (!HOST || !SECRET || !WS_PATH) {
  console.error("missing required env: VLESS_HOST / SUB_SECRET / WS_PATH");
  process.exit(1);
}

const NODE_VISION = "wr-vps-vision";
const NODE_WS = "wr-vps-ws";
const NODE_HY2 = "wr-vps-hy2";
const HY2_ENABLED = HY2_AUTH !== "";

type Client = { id: string; flow?: string };
type Inbound = {
  protocol: string;
  settings?: { clients?: Client[] };
  streamSettings?: { network?: string };
};

function loadInbounds(): Inbound[] {
  const cfg = JSON.parse(readFileSync(XRAY_CONFIG, "utf8"));
  return (cfg.inbounds ?? []) as Inbound[];
}

function uuidOf(inbounds: Inbound[]): string | null {
  for (const ib of inbounds) {
    if (ib.protocol === "vless") {
      const clients = ib.settings?.clients ?? [];
      if (clients.length > 0) return clients[0].id;
    }
  }
  return null;
}

function vlessUrl(uuid: string, name: string, port: number, ws: boolean): string {
  const q = new URLSearchParams(
    ws
      ? {
          type: "websocket",
          security: "tls",
          encryption: "none",
          path: WS_PATH,
          host: HOST,
          sni: HOST,
          alpn: "http/1.1",
          fp: "chrome",
          allowInsecure: "0",
        }
      : {
          type: "tcp",
          security: "tls",
          encryption: "none",
          flow: "xtls-rprx-vision",
          sni: HOST,
          alpn: "h2,http/1.1",
          fp: "chrome",
          allowInsecure: "0",
        },
  );
  return `vless://${uuid}@${HOST}:${port}?${q.toString()}#${encodeURIComponent(name)}`;
}

function hy2Url(name: string): string | null {
  if (!HY2_ENABLED) return null;
  const q = new URLSearchParams({ sni: HOST, insecure: "0" });
  if (HY2_OBFS) {
    q.set("obfs", "salamander");
    q.set("obfs-password", HY2_OBFS);
  }
  return `hysteria2://${encodeURIComponent(HY2_AUTH)}@${HOST}:${HY2_PORT}?${q.toString()}#${encodeURIComponent(name)}`;
}

function shareLinks(uuid: string): string[] {
  return [
    hy2Url(NODE_HY2),
    vlessUrl(uuid, NODE_VISION, VLESS_PORT, false),
    vlessUrl(uuid, NODE_WS, WS_PORT, true),
  ].filter((link): link is string => link !== null);
}

function fmtGb(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(2);
}

function visionProxy(uuid: string): string {
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

function wsProxy(uuid: string): string {
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

function hy2Proxy(): string {
  if (!HY2_ENABLED) return "";
  const obfs = HY2_OBFS
    ? `
    obfs: salamander
    obfs-password: ${HY2_OBFS}`
    : "";
  return `  - name: "${NODE_HY2}"
    type: hysteria2
    server: ${HOST}
    port: ${HY2_PORT}
    password: ${HY2_AUTH}
    sni: ${HOST}
    skip-cert-verify: false${obfs}`;
}

function nodeNames(): string[] {
  const names = [NODE_HY2, NODE_VISION, NODE_WS];
  return HY2_ENABLED ? names : names.filter((name) => name !== NODE_HY2);
}

function clashYaml(uuid: string, up: number, down: number): string {
  const usage = `📊 本月已用：${fmtGb(up + down)} GB`;
  const proxies = [hy2Proxy(), visionProxy(uuid), wsProxy(uuid)]
    .filter((block) => block !== "")
    .concat(
      `  - { name: "${usage}", type: trojan, server: 127.0.0.1, port: 1, password: info, udp: false }`,
    )
    .join("\n\n");
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
  - name: 节点选择
    type: select
    proxies: [自动选择, ${nodes}, "${usage}", DIRECT]
  - name: 自动选择
    type: url-test
    proxies: [${nodes}]
    url: 'http://cp.cloudflare.com'
    interval: 300

rules:
  - GEOIP,LAN,DIRECT,no-resolve
  - GEOSITE,CN,DIRECT
  - GEOIP,CN,DIRECT
  - MATCH,节点选择
`;
}

function base64Links(uuid: string): string {
  return Buffer.from(shareLinks(uuid).join("\n"), "utf8").toString("base64");
}

function vnstatBytes(): { up: number; down: number } | null {
  const out = execFileSync("/usr/bin/vnstat", ["--json", "m", "1", "-i", NET_IF], {
    encoding: "utf8",
    timeout: 5000,
  });
  const month = JSON.parse(out).interfaces?.[0]?.traffic?.month?.[0];
  if (!month) return null;
  return { up: month.rx ?? 0, down: month.tx ?? 0 };
}

function procNetDevBytes(): { up: number; down: number } | null {
  for (const line of readFileSync("/proc/net/dev", "utf8").split("\n")) {
    const m = line.match(/^\s*([a-z0-9]+):\s+(\d+)\s+(?:\d+\s+){7}(\d+)/);
    if (m && m[1] === NET_IF) {
      return { up: Number(m[2]), down: Number(m[3]) };
    }
  }
  return null;
}

function trafficBytes(): { up: number; down: number } {
  for (const read of [vnstatBytes, procNetDevBytes]) {
    try {
      const bytes = read();
      if (bytes) return bytes;
    } catch {}
  }
  return { up: 0, down: 0 };
}

const server = createServer({ cert: readFileSync(CERT), key: readFileSync(KEY) }, (req, res) => {
  try {
    serve(req.url, req.headers["user-agent"], res);
  } catch (error) {
    console.error("subscription request failed", error);
    if (!res.headersSent) {
      res.writeHead(500).end();
    }
  }
});

function serve(
  pathname: string | undefined,
  userAgent: string | undefined,
  res: ServerResponse,
): void {
  const url = new URL(pathname ?? "/", `https://${HOST}`);
  if (!SECRET || (url.pathname !== `/${SECRET}/sub` && url.pathname !== `/${SECRET}/vless`)) {
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
    res.end(shareLinks(uuid).join("\n") + "\n");
    return;
  }

  if (ua.includes("clash") || ua.includes("mihomo") || ua.includes("verge")) {
    res.writeHead(200, {
      "Content-Type": "text/yaml; charset=utf-8",
      "subscription-userinfo": userinfo,
      "profile-update-interval": "1",
      "content-disposition": `attachment; filename*=UTF-8''wr-vps.yaml`,
    });
    res.end(clashYaml(uuid, up, down));
  } else {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "subscription-userinfo": userinfo,
      "profile-update-interval": "1",
    });
    res.end(base64Links(uuid));
  }
}

server.listen(PORT, "0.0.0.0");
