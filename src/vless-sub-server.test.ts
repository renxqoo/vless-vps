import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";

const source = resolve(import.meta.dir, "vless-sub-server.ts");
const uuid = "11111111-1111-4111-8111-111111111111";
const nextUuid = "22222222-2222-4222-8222-222222222222";
const fixtures: { dir: string; process: ChildProcess }[] = [];
let certDir: string;

beforeAll(async () => {
  certDir = await mkdtemp(join(tmpdir(), "vless-cert-test-"));
  const result = Bun.spawnSync([
    "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem"),
    "-days", "1", "-subj", "/CN=localhost",
  ]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
});

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    if (fixture.process.exitCode === null && fixture.process.signalCode === null) {
      const closed = once(fixture.process, "exit");
      fixture.process.kill();
      await closed;
    }
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

afterAll(async () => { await rm(certDir, { recursive: true, force: true }); });

async function start(extraEnv: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "vless-sub-test-"));
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((done) => socket.close(() => done()));
  await mkdir(join(dir, "bin"));
  await writeFile(join(dir, ".env"), "");
  const config = join(dir, "xray.json");
  await writeFile(config, JSON.stringify({ inbounds: [{ protocol: "vless", settings: { clients: [{ id: uuid }] } }] }));
  await writeFile(join(dir, "traffic.json"), JSON.stringify({ interfaces: [{ traffic: { month: [{ rx: 1048576, tx: 2097152 }] } }] }));
  await writeFile(join(dir, "bin", "vnstat"), `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync("calls", "1\\n");
await Bun.sleep(Number(process.env.TEST_TRAFFIC_DELAY ?? 0));
process.stdout.write(readFileSync("traffic.json", "utf8"));
`, { mode: 0o755 });
  const child = spawn(process.execPath, [source], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      SUB_PORT: String(port), VLESS_HOST: "127.0.0.1", SUB_SECRET: "test-secret",
      WS_PATH: "/test-ws", XRAY_CONFIG: config,
      CERT_FILE: join(certDir, "cert.pem"), KEY_FILE: join(certDir, "key.pem"),
      HY2_AUTH: "test-password", HY2_OBFS: "test-obfs", TRAFFIC_CACHE_TTL_MS: "30000",
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  fixtures.push({ dir, process: child });
  let errors = "";
  child.stderr!.on("data", (chunk) => { errors += chunk; });
  const get = (path = "/test-secret/sub", method = "GET", ua = "clash-verge") =>
    new Promise<{ status: number; headers: Record<string, any>; body: string }>((done, fail) => {
      const req = request({ hostname: "127.0.0.1", port, path, method,
        rejectUnauthorized: false, headers: { "user-agent": ua } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => done({ status: res.statusCode!, headers: res.headers, body }));
        res.on("error", fail);
      });
      req.on("error", fail);
      req.setTimeout(3000, () => req.destroy(new Error("request timed out")));
      req.end();
    });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited: ${errors}`);
    try { await get("/not-a-subscription"); return { dir, config, get }; }
    catch { await Bun.sleep(20); }
  }
  throw new Error(`server did not start: ${errors}`);
}

async function calls(dir: string) {
  try { return (await readFile(join(dir, "calls"), "utf8")).trim().split("\n").length; }
  catch { return 0; }
}

test("YAML preserves special characters and lists only usable proxies", async () => {
  const password = 'secret: # [yes] "quoted"';
  const { get } = await start({ HY2_AUTH: password, HY2_OBFS: password, WS_PATH: "/ws: #fragment" });
  const response = await get();
  expect(response.status).toBe(200);
  const config = Bun.YAML.parse(response.body) as any;
  expect(config.proxies.map((p: any) => p.name)).toEqual(["wr-vps-hy2", "wr-vps-vision", "wr-vps-ws"]);
  expect(config.proxies[0].password).toBe(password);
  expect(config.proxies[0]["obfs-password"]).toBe(password);
  expect(config.proxies[2]["ws-opts"].path).toBe("/ws: #fragment");
  expect(config["proxy-groups"].find((g: any) => g.name === "故障转移").proxies).toEqual(["wr-vps-hy2", "wr-vps-vision", "wr-vps-ws"]);
  expect(config["proxy-groups"].find((g: any) => g.name === "自动选择").tolerance).toBe(50);
});

test("explicit format works independently of User-Agent; existing formats remain usable", async () => {
  const { get } = await start();
  const clash = await get("/test-secret/sub?format=clash", "GET", "curl/8");
  expect(clash.headers["content-type"]).toContain("yaml");
  expect((Bun.YAML.parse(clash.body) as any).proxies).toHaveLength(3);
  const base64 = await get("/test-secret/sub", "GET", "v2rayNG");
  const links = Buffer.from(base64.body, "base64").toString("utf8").split("\n");
  expect(links).toHaveLength(3);
  expect(links[0]).toStartWith("hysteria2://");
  expect(links[1]).toContain(uuid);
  expect((await get("/test-secret/sub?format=links")).body.trim().split("\n")).toEqual(links);
  expect((await get("/test-secret/sub?format=unknown")).status).toBe(400);
});

test("slow traffic collection is shared and does not block other requests", async () => {
  const { dir, get } = await start({ TEST_TRAFFIC_DELAY: "500" });
  const responses = Array.from({ length: 8 }, () => get());
  await Bun.sleep(100);
  const before = performance.now();
  expect((await get("/unknown")).status).toBe(404);
  expect(performance.now() - before).toBeLessThan(300);
  for (const response of await Promise.all(responses)) {
    expect(response.headers["subscription-userinfo"]).toContain("upload=1048576; download=2097152;");
  }
  await get();
  expect(await calls(dir)).toBe(1);
});

test("expired traffic is served promptly and failed refresh keeps the last good counters", async () => {
  const { dir, get } = await start({ TRAFFIC_CACHE_TTL_MS: "100", TEST_TRAFFIC_DELAY: "400" });
  const initial = await get();
  await writeFile(join(dir, "traffic.json"), "invalid-json");
  await Bun.sleep(130);
  const before = performance.now();
  const cached = await get();
  expect(performance.now() - before).toBeLessThan(300);
  expect(cached.headers["subscription-userinfo"]).toBe(initial.headers["subscription-userinfo"]);
  await Bun.sleep(500);
  expect((await get()).headers["subscription-userinfo"]).toBe(initial.headers["subscription-userinfo"]);
  expect(await calls(dir)).toBe(2);
});

test("links see UUID rotation immediately and do not run vnstat", async () => {
  const { dir, config, get } = await start();
  expect((await get("/test-secret/vless")).body).toContain(uuid);
  await writeFile(config, JSON.stringify({ inbounds: [{ protocol: "vless", settings: { clients: [{ id: nextUuid }] } }] }));
  const rotated = await get("/test-secret/vless");
  expect(rotated.body).toContain(nextUuid);
  expect(rotated.body).not.toContain(uuid);
  expect(await calls(dir)).toBe(0);
});

test("HEAD and method validation preserve credentials and skip unnecessary work", async () => {
  const { dir, get } = await start({ TEST_TRAFFIC_DELAY: "500" });
  const rejected = await get("/test-secret/sub", "POST");
  expect(rejected.status).toBe(405);
  expect(rejected.headers.allow).toBe("GET, HEAD");
  expect(await calls(dir)).toBe(0);
  const head = await get("/test-secret/sub", "HEAD");
  expect(head.status).toBe(200);
  expect(head.body).toBe("");
  expect(head.headers["cache-control"]).toBe("private, no-store");
  expect((await get("/wrong-secret/sub")).status).toBe(404);
});

test("disabling Hysteria removes it from all groups and share links", async () => {
  const { get } = await start({ HY2_AUTH: "" });
  const config = Bun.YAML.parse((await get()).body) as any;
  expect(config.proxies.map((p: any) => p.name)).toEqual(["wr-vps-vision", "wr-vps-ws"]);
  for (const group of config["proxy-groups"]) expect(group.proxies).not.toContain("wr-vps-hy2");
  expect((await get("/test-secret/vless")).body).not.toContain("hysteria2://");
});

test("download strategy favors Hysteria and checks failures more promptly", async () => {
  const { get } = await start();
  const config = Bun.YAML.parse((await get()).body) as any;
  const hy2 = config.proxies.find((proxy: any) => proxy.type === "hysteria2");
  expect(hy2.up).toBeUndefined();
  expect(hy2.down).toBeUndefined();
  const select = config["proxy-groups"].find((group: any) => group.name === "节点选择");
  const fallback = config["proxy-groups"].find((group: any) => group.name === "故障转移");
  expect(select.proxies[0]).toBe("故障转移");
  expect(fallback.proxies).toEqual(["wr-vps-hy2", "wr-vps-vision", "wr-vps-ws"]);
  expect(fallback.interval).toBe(60);
  expect(fallback["max-failed-times"]).toBe(2);
  expect((await get("/test-secret/vless")).body).not.toContain("Mbps");
});

test.each([
  ["198.51.100.8", "IP-CIDR,198.51.100.8/32,DIRECT,no-resolve"],
  ["proxy.example.com", "DOMAIN,proxy.example.com,DIRECT"],
])("proxy endpoint %s bypasses its own tunnel before other routing rules", async (host, rule) => {
  const { get } = await start({ VLESS_HOST: host });
  const config = Bun.YAML.parse((await get()).body) as any;
  expect(config.rules[0]).toBe(rule);
  expect(config.rules.at(-1)).toBe("MATCH,节点选择");
});
