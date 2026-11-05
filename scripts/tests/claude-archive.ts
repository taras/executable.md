import { gunzipSync } from "node:zlib";
import { Buffer } from "node:buffer";

export function claudeArchive(
  bytes: Uint8Array,
): Map<
  string,
  { bytes: Buffer; mode: number; uid: number; gid: number; mtime: number; type: string }
> {
  const raw = gunzipSync(bytes);
  const members = new Map<
    string,
    { bytes: Buffer; mode: number; uid: number; gid: number; mtime: number; type: string }
  >();
  for (let at = 0; at + 512 <= raw.length; ) {
    const header = raw.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const text = (start: number, end: number): string =>
      header.subarray(start, end).toString("utf8").replace(/\0.*$/, "");
    const number = (start: number, end: number): number =>
      Number.parseInt(text(start, end).trim(), 8);
    const name = text(0, 100);
    const size = number(124, 136);
    const type = text(156, 157);
    if (type !== "0" || members.has(name) || !Number.isFinite(size)) {
      throw new Error(`Unexpected tar member ${name} (${type})`);
    }
    members.set(name, {
      bytes: raw.subarray(at + 512, at + 512 + size),
      mode: number(100, 108),
      uid: number(108, 116),
      gid: number(116, 124),
      mtime: number(136, 148),
      type,
    });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return members;
}
