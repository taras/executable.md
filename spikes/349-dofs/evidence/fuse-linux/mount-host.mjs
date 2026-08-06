// Goal 2 host: full stack.
//   FileSQLiteStorage(file db) -> Database -> initializeSchema
//   -> SQLiteWorkspaceProvider -> prototype splice -> vfs create (+forwarding)
//   -> makeFUSEOps/mountFuse (compiled CJS driver) -> /mnt/ws
// Then serves an HTTP control API on 127.0.0.1:9976 so separate processes
// (curl in docker exec) can drive the dofs API side while shells poke the mount.
//
// Runtime-agnostic on purpose: `deno run --allow-all mount-host.mjs ...`
// aborts in the uv polyfill at mount() (goal 1/2 finding); `node
// mount-host.mjs ...` is the working sidecar topology.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import process from "node:process";
import { createFileVfs, verifySqliteBacked } from "./vfs-wiring.mjs";

const [dbPath = "/probe/data/ws.db", mountPoint = "/mnt/ws"] = process.argv.slice(2);
const require = createRequire(import.meta.url);

const t0 = performance.now();
const handle = createFileVfs(dbPath);
const { vfs, wfs, storage } = handle;
// makeFUSEOps uses mountPoint as the VFS namespace prefix: kernel "/"
// maps to vfs "<mountPoint>". The backing dir chain must exist in the vfs
// or every op (including getattr of the mount root) returns ENOENT.
{
  const segments = mountPoint.split("/").filter(Boolean);
  let acc = "";
  for (const seg of segments) {
    acc += `/${seg}`;
    if (!vfs.existsSync(acc)) vfs.mkdirSync(acc, { mode: 0o755 });
  }
}
if (!vfs.existsSync("/workspace")) vfs.mkdirSync("/workspace", { mode: 0o755 });
const sqliteProof = await verifySqliteBacked(handle, dbPath);
const tVfs = performance.now();

// Record whether writeFileRangesSync reached the facade (upstream omits it
// from the forward list even though driver.ts probes for it).
const forwarding = Object.fromEntries(
  [
    "linkSync", "createFileSync", "writeRangeSync", "truncateFileSync",
    "chmodSync", "readRangeSync", "openWriteBufferSync",
    "openWriteBufferForCreateSync", "releaseWriteBufferSync",
    "writeFileRangesSync",
  ].map((name) => [name, typeof vfs[name]]),
);

const { mountFuse } = require("./dist-cjs/driver.js");
const tRequire = performance.now();
const mount = await mountFuse({ mountPoint, vfs });
const tMounted = performance.now();

console.log(JSON.stringify({
  event: "mounted",
  runtime: typeof Deno === "undefined" ? `node ${process.version}` : `deno ${Deno.version.deno}`,
  pid: process.pid,
  dbPath,
  mountPoint,
  sqliteProof,
  forwarding,
  timingsMs: {
    vfsUp: r(tVfs - t0),
    driverRequire: r(tRequire - tVfs),
    fuseMount: r(tMounted - tRequire),
    total: r(tMounted - t0),
  },
}));

function r(x) { return Math.round(x * 100) / 100; }

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:9976");
  const q = (k) => url.searchParams.get(k);
  const json = (obj, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  try {
    switch (url.pathname) {
      case "/write": {
        const t = performance.now();
        await wfs.writeFile(q("path"), q("body") ?? "");
        return json({ ok: true, ms: r(performance.now() - t) });
      }
      case "/read": {
        const t = performance.now();
        const body = await wfs.readFile(q("path"), "utf8");
        return json({ ok: true, body, ms: r(performance.now() - t) });
      }
      case "/ls": {
        const entries = (await wfs.readdir(q("path"))).map((e) => e.name).sort();
        return json({ ok: true, entries });
      }
      case "/stats":
        return json({ ok: true, bufferStats: mount.getBufferStats?.() ?? null });
      case "/bench-direct": {
        const n = Number(q("n") ?? 100);
        const t = performance.now();
        for (let i = 0; i < n; i++) {
          await wfs.writeFile(`${mountPoint}/bench-api-${i}.txt`, `payload-${i}\n`);
        }
        const total = r(performance.now() - t);
        return json({ ok: true, n, totalMs: total, perOpMs: r(total / n) });
      }
      case "/exec": {
        // Upstream exec/runner.ts technique: NEVER pass cwd: <dir inside own
        // mount> to spawn from the process serving FUSE (uv_spawn forks then
        // chdirs pre-exec; the chdir triggers a FUSE request only this
        // process can serve -> deadlock). Instead prefix `cd <dir> &&` so the
        // chdir happens in the child shell after exec.
        const dir = q("cwd") ?? "/";
        const cmd = q("cmd") ?? "pwd";
        const { execFile } = await import("node:child_process");
        const t = performance.now();
        const out = await new Promise((resolve) => {
          execFile("/bin/sh", ["-c", `cd ${dir} && ${cmd}`], { timeout: 10_000 },
            (error, stdout, stderr) => resolve({ error: error ? String(error) : null, stdout, stderr }));
        });
        return json({ ok: out.error === null, technique: "cd-prefix", ...out, ms: r(performance.now() - t) });
      }
      case "/exec-cwd": {
        // The hazardous variant, for characterization only: spawn with the
        // cwd option pointing inside our own mount.
        const dir = q("cwd") ?? "/mnt/ws";
        const { execFile } = await import("node:child_process");
        const t = performance.now();
        const out = await new Promise((resolve) => {
          execFile("/bin/sh", ["-c", q("cmd") ?? "pwd"], { cwd: dir, timeout: 10_000 },
            (error, stdout, stderr) => resolve({ error: error ? String(error) : null, stdout, stderr }));
        });
        return json({ ok: out.error === null, technique: "spawn-cwd-option", ...out, ms: r(performance.now() - t) });
      }
      case "/unmount": {
        await mount.unmount();
        storage.close();
        setTimeout(() => process.exit(0), 100);
        return json({ ok: true, unmounted: true });
      }
      default:
        return json({ ok: false, error: "unknown endpoint" }, 404);
    }
  } catch (error) {
    return json({ ok: false, error: String(error?.message ?? error), code: error?.code }, 500);
  }
});
server.listen(9976, "127.0.0.1", () => {
  console.log(JSON.stringify({ event: "control-api", port: 9976 }));
});
