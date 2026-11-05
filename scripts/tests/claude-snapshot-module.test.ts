import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { until } from "effection";
import { gunzipSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { writeTextFile } from "@effectionx/fs";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { pathToFileURL } from "node:url";
import { gzipStored, crc32, sha256, claudeSnapshotModule } from "../lib/claude-snapshot-module.ts";
import { packClaude } from "../lib/prepare-claude.ts";
import { claudeArchive } from "./claude-archive.ts";

describe("Claude snapshot serialization", () => {
  for (const length of [0, 1, 65535, 65536]) {
    it(`round trips ${length} stored bytes`, function* () {
      const bytes = Uint8Array.from({ length }, (_, i) => i % 251);
      const compressed = gzipStored(bytes);
      expect([...compressed.subarray(0, 10)]).toEqual([31, 139, 8, 0, 0, 0, 0, 0, 0, 255]);
      expect(gunzipSync(compressed)).toEqual(Buffer.from(bytes));
      expect(gzipStored(bytes)).toEqual(compressed);
    });
  }
  it("uses the IEEE CRC32 check vector", function* () {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  it("packs sorted regular files with fixed metadata and imports the descriptor", function* () {
    const members = [
      { path: "z.txt", bytes: Buffer.from("z") },
      { path: "dist/index.js", bytes: Buffer.from("hello") },
    ];
    const bytes = yield* packClaude(members);
    expect(yield* packClaude([...members].reverse())).toEqual(bytes);
    const files = claudeArchive(bytes);
    expect([...files.keys()]).toEqual(["package/dist/index.js", "package/z.txt"]);
    expect(
      [...files.values()].map(({ mode, uid, gid, mtime, type }) => ({
        mode,
        uid,
        gid,
        mtime,
        type,
      })),
    ).toEqual([
      { mode: 0o755, uid: 0, gid: 0, mtime: 0, type: "0" },
      { mode: 0o644, uid: 0, gid: 0, mtime: 0, type: "0" },
    ]);
    const root = yield* useTempDirectory("claude-module-");
    const path = pathToFileURL(`${root}/snapshot.ts`);
    yield* writeTextFile(path, claudeSnapshotModule(bytes));
    const loaded = yield* until(import(path.href));
    expect(Buffer.from(loaded.CLAUDE_SNAPSHOT.base64, "base64")).toEqual(Buffer.from(bytes));
    expect(loaded.CLAUDE_SNAPSHOT.sha256).toBe(sha256(bytes));
    expect(loaded.CLAUDE_SNAPSHOT.byteLength).toBe(bytes.length);
  });
});
