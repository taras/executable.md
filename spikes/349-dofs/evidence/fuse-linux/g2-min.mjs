// Minimal mount repro, runtime-agnostic (node g2-min.mjs / deno run -A g2-min.mjs).
// Mounts a trivial one-file FS, stats it, unmounts. Isolates the FUSE binding
// from the dofs/vfs stack.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Fuse = require("fuse-native");

const mountPoint = process.argv[2] ?? "/mnt/ws";
const stat = (mode, size) => ({
  mtime: new Date(), atime: new Date(), ctime: new Date(),
  size, mode, uid: 0, gid: 0,
});
const ops = {
  readdir: (path, cb) => cb(0, path === "/" ? ["hello.txt"] : []),
  getattr: (path, cb) => {
    if (path === "/") return cb(0, stat(0o40755, 4096));
    if (path === "/hello.txt") return cb(0, stat(0o100644, 6));
    return cb(Fuse.ENOENT);
  },
  open: (path, flags, cb) => cb(0, 42),
  read: (path, fd, buf, len, pos, cb) => {
    const data = Buffer.from("hello\n").subarray(pos, pos + len);
    data.copy(buf);
    cb(data.length);
  },
  release: (path, fd, cb) => cb(0),
};

console.log(JSON.stringify({ event: "constructing", mountPoint }));
const fuse = new Fuse(mountPoint, ops, { autoUnmount: true, debug: false });
const t0 = performance.now();
fuse.mount((err) => {
  if (err) {
    console.log(JSON.stringify({ event: "mount-error", error: String(err) }));
    process.exit(1);
  }
  console.log(JSON.stringify({ event: "mounted", ms: Math.round(performance.now() - t0) }));
  setTimeout(() => {
    fuse.unmount((err2) => {
      console.log(JSON.stringify({ event: "unmounted", error: err2 ? String(err2) : null }));
      process.exit(0);
    });
  }, 10_000);
});
