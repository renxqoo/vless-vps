import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:https";

const PORT = 8443;
const XRAY_CONFIG = "/usr/local/etc/xray/config.json";
const CERT = "/etc/xray-certs/fullchain.pem";
const KEY = "/etc/xray-certs/privkey.pem";
const HOST = "103.248.228.194";
const VLESS_PORT = 443;
const WS_PORT = 2053;
const NET_IF = "ens17";
const TOTAL_BYTES = 200 * 1024 * 1024 * 1024;
const SECRET = process.env.SUB_SECRET ?? "";
const WS_PATH = process.env.WS_PATH ?? "";

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

function fmtGb(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(2);
}

function clashYaml(uuid: string, up: number, down: number): string {
  const usage = `📊 本月已用：${fmtGb(up + down)} GB`;
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
  - name: 节点选择
    type: select
    proxies: [自动选择, wr-vps-vision, wr-vps-ws, "${usage}", DIRECT]
  - name: 自动选择
    type: url-test
    proxies: [wr-vps-vision, wr-vps-ws]
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
  const links = [
    vlessUrl(uuid, "wr-vps-vision", VLESS_PORT, false),
    vlessUrl(uuid, "wr-vps-ws", WS_PORT, true),
  ];
  return Buffer.from(links.join("\n"), "utf8").toString("base64");
}

function trafficBytes(): { up: number; down: number } {
  try {
    const out = execFileSync("/usr/bin/vnstat", ["--json", "m", "1", "-i", NET_IF], {
      encoding: "utf8",
      timeout: 5000,
    });
    const month = JSON.parse(out).interfaces?.[0]?.traffic?.month?.[0];
    if (month) {
      return { up: month.rx ?? 0, down: month.tx ?? 0 };
    }
  } catch {
    for (const line of readFileSync("/proc/net/dev", "utf8").split("\n")) {
      const m = line.match(/^\s*([a-z0-9]+):\s+(\d+)\s+(?:\d+\s+){7}(\d+)/);
      if (m && m[1] === NET_IF) {
        return { up: Number(m[2]), down: Number(m[3]) };
      }
    }
  }
  return { up: 0, down: 0 };
}

const server = createServer(
  { cert: readFileSync(CERT), key: readFileSync(KEY) },
  (req, res) => {
    const url = new URL(req.url ?? "/", `https://${HOST}`);
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
    const ua = (req.headers["user-agent"] ?? "").toLowerCase();

    if (url.pathname.endsWith("/vless")) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(
        vlessUrl(uuid, "wr-vps-vision", VLESS_PORT, false) +
          "\n" +
          vlessUrl(uuid, "wr-vps-ws", WS_PORT, true) +
          "\n",
      );
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
  },
);

server.listen(PORT, "0.0.0.0");
