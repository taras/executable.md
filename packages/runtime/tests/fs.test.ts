/**
 * Tier FS — the contextual filesystem's link classification, and the one level
 * `readDirectory` answers with.
 *
 * `stat` answers about what a path leads to and `lstat` answers about the entry
 * itself. The difference only shows on a symbolic link, so every case here is
 * built from real links in a temporary directory: an in-memory stub cannot
 * tell the two operations apart because it has nothing for a link to point at.
 * `readDirectory` reads the same tree for the same reason — a link is an entry
 * it reports as itself.
 *
 * `mkdtemp`, `realpath` and `symlink` have no `@effectionx/fs` equivalent;
 * everything else goes through the contextual operations under test.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, until } from "effection";
import type { Operation } from "effection";
import { rm, writeTextFile } from "@effectionx/fs";
import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { lstat, readDirectory, stat } from "../apis.ts";

/**
 * A directory symlink, spelled the way the running platform accepts one. A
 * junction is what Windows gives an unprivileged process; everywhere else it
 * is an ordinary directory symlink.
 */
const DIRECTORY_LINK = process.platform === "win32" ? "junction" : "dir";

/** A tree holding one of every entry the two operations answer differently for. */
interface Fixture {
  root: string;
  file: string;
  directory: string;
  fileLink: string;
  directoryLink: string;
  dangling: string;
  missing: string;
}

function useFixture(): Operation<Fixture> {
  return resource(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "fs-test-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));

    const file = join(root, "file.txt");
    const directory = join(root, "directory");
    const nested = join(directory, "nested.txt");
    yield* writeTextFile(file, "content\n");
    yield* until(mkdir(directory));
    yield* writeTextFile(nested, "nested\n");

    const fileLink = join(root, "file-link.txt");
    const directoryLink = join(root, "directory-link");
    const dangling = join(root, "dangling");
    yield* until(symlink(file, fileLink));
    yield* until(symlink(directory, directoryLink, DIRECTORY_LINK));
    yield* until(symlink(join(root, "nowhere"), dangling));

    yield* provide({
      root,
      file,
      directory,
      fileLink,
      directoryLink,
      dangling,
      missing: join(root, "absent"),
    });
  });
}

describe("Tier FS: link classification", () => {
  it("answers a missing path without throwing, from both operations", function* () {
    const fixture = yield* useFixture();

    expect(yield* stat(fixture.missing)).toEqual({
      exists: false,
      isFile: false,
      isDirectory: false,
    });
    expect(yield* lstat(fixture.missing)).toEqual({
      exists: false,
      isFile: false,
      isDirectory: false,
      isSymbolicLink: false,
    });
  });

  it("agrees about a plain file and a plain directory", function* () {
    const fixture = yield* useFixture();

    expect(yield* stat(fixture.file)).toEqual({ exists: true, isFile: true, isDirectory: false });
    expect(yield* lstat(fixture.file)).toEqual({
      exists: true,
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
    });

    expect(yield* stat(fixture.directory)).toEqual({
      exists: true,
      isFile: false,
      isDirectory: true,
    });
    expect(yield* lstat(fixture.directory)).toEqual({
      exists: true,
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
    });
  });

  it("reports the link itself while stat still follows it to a file", function* () {
    const fixture = yield* useFixture();

    expect(yield* stat(fixture.fileLink)).toEqual({
      exists: true,
      isFile: true,
      isDirectory: false,
    });
    expect(yield* lstat(fixture.fileLink)).toEqual({
      exists: true,
      isFile: false,
      isDirectory: false,
      isSymbolicLink: true,
    });
  });

  it("reports the link itself while stat still follows it to a directory", function* () {
    const fixture = yield* useFixture();

    expect(yield* stat(fixture.directoryLink)).toEqual({
      exists: true,
      isFile: false,
      isDirectory: true,
    });
    expect(yield* lstat(fixture.directoryLink)).toEqual({
      exists: true,
      isFile: false,
      isDirectory: false,
      isSymbolicLink: true,
    });
  });

  it("separates a dangling link from an absent path", function* () {
    const fixture = yield* useFixture();

    // The target is gone, so following it lands on nothing — the same answer a
    // path that was never there gives.
    expect(yield* stat(fixture.dangling)).toEqual({
      exists: false,
      isFile: false,
      isDirectory: false,
    });
    // The link is still an entry in the directory, which is what makes a
    // dangling link distinguishable from absence at all.
    expect(yield* lstat(fixture.dangling)).toEqual({
      exists: true,
      isFile: false,
      isDirectory: false,
      isSymbolicLink: true,
    });
  });
});

describe("Tier FS: one directory level", () => {
  it("FS6: reports the direct entries as plain values, and nothing beneath them", function* () {
    const fixture = yield* useFixture();

    const entries = yield* readDirectory(fixture.root);

    // Host enumeration order is not part of the answer, so the comparison
    // fixes an order the host never promised.
    expect([...entries].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "dangling", isFile: false, isDirectory: false, isSymbolicLink: true },
      { name: "directory", isFile: false, isDirectory: true, isSymbolicLink: false },
      { name: "directory-link", isFile: false, isDirectory: false, isSymbolicLink: true },
      { name: "file-link.txt", isFile: false, isDirectory: false, isSymbolicLink: true },
      { name: "file.txt", isFile: true, isDirectory: false, isSymbolicLink: false },
    ]);

    // One level: the file inside `directory` is reported by reading that
    // directory, never by reading its parent.
    expect(entries.map((entry) => entry.name)).not.toContain("nested.txt");
    expect((yield* readDirectory(fixture.directory)).map((entry) => entry.name)).toEqual([
      "nested.txt",
    ]);
  });
});
