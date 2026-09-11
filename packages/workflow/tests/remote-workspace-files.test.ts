/**
 * Tier WRH — what the runner's Workspace filesystem will act on.
 *
 * The attempt is a real directory on a host that has an outside, and a symbolic
 * link is a path the kernel follows on its own. So these use real temporary
 * files and the production adapter: a fake filesystem would follow whatever the
 * fake decided to follow, which is the one thing under test.
 *
 * The rule is the host provider's, stated in `packages/runtime/host-files.ts`:
 * a complete `..` segment leaves and `..notes.md` does not; an operation about
 * a link does not follow it; and a link's target is a Workspace path, so an
 * absolute one names the Workspace root rather than the machine's.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { type Operation, until } from "effection";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { useRunnerTrees } from "../src/deno/remote-files.ts";
import { createRemoteWorkspaceFilesystem } from "../src/deno/remote-workspace-files.ts";
import type { WorkspaceFilesystem } from "../src/workspace/filesystem.ts";

const SECRET = "the file outside\n";

interface Scene {
  readonly files: WorkspaceFilesystem;
  readonly attempt: string;
  readonly outside: string;
}

/**
 * An attempt directory, and a separate directory it must never reach.
 *
 * Both are real, and the outside one holds a file whose bytes are recognizable:
 * an escape that succeeded would return exactly them.
 */
function* scene(): Operation<Scene> {
  const trees = yield* useRunnerTrees();
  const attempt = yield* trees.create("attempt");
  const outside = yield* trees.create("outside");
  yield* until(writeFile(`${outside}/secret.txt`, SECRET, { mode: 0o644 }));
  yield* until(mkdir(`${attempt}/docs`, { mode: 0o755 }));
  yield* until(writeFile(`${attempt}/docs/inside.txt`, "inside\n", { mode: 0o644 }));
  const files = createRemoteWorkspaceFilesystem(
    (logical) => (logical === "/" ? attempt : `${attempt}${logical}`),
    () => {},
  );
  return { files, attempt, outside };
}

/** What an operation refused with, having proved it refused at all. */
function* refusal(operation: Operation<unknown>): Operation<string> {
  try {
    yield* operation;
    return "it was allowed";
  } catch (error) {
    return String(error);
  }
}

describe("the runner's Workspace filesystem", () => {
  it("follows a link inside the attempt, and leaves it a link", function* () {
    const { files, attempt } = yield* scene();
    yield* until(symlink("docs/inside.txt", `${attempt}/here`));

    expect(yield* files.readTextFile("/here")).toBe("inside\n");
    // The contract of each: one is about the file, the other about the entry.
    expect((yield* files.stat("/here")).kind).toBe("file");
    expect((yield* files.lstat("/here")).kind).toBe("symlink");
    expect(yield* files.readlink("/here")).toBe("docs/inside.txt");

    yield* files.writeFile("/here", "through the link\n", 0o644);
    // The file the link names changed; the link is still a link.
    expect(yield* until(readFile(`${attempt}/docs/inside.txt`, "utf8"))).toBe("through the link\n");
    expect((yield* files.lstat("/here")).kind).toBe("symlink");
  });

  it("reads a Workspace-absolute link target against the attempt, not the host", function* () {
    const { files, attempt } = yield* scene();
    // The target is a Workspace path. Interpreted by the kernel it would be a
    // machine path; interpreted here it is this attempt's own `/docs`.
    yield* until(symlink("/docs/inside.txt", `${attempt}/logical`));
    expect(yield* files.readTextFile("/logical")).toBe("inside\n");
  });

  it("exposes nothing through a final link that leaves the attempt", function* () {
    const { files, attempt, outside } = yield* scene();
    yield* until(symlink(`${outside}/secret.txt`, `${attempt}/escape`));
    yield* until(symlink("../../../../etc/hosts", `${attempt}/relative`));

    for (const path of ["/escape", "/relative"]) {
      // The host-absolute target is a Workspace path here, so it names nothing;
      // the relative one climbs out of the tree and is refused. Neither is a
      // way to the bytes, which is the claim.
      expect([path, yield* refusal(files.readTextFile(path))]).not.toEqual([
        path,
        "it was allowed",
      ]);
      expect(yield* refusal(files.readTextFile(path))).not.toContain("the file outside");
      yield* refusal(files.writeFile(path, "overwritten\n"));
      yield* refusal(files.chmod(path, 0o600));
    }
    // Neither the outside file nor the link it went through changed.
    expect(yield* until(readFile(`${outside}/secret.txt`, "utf8"))).toBe(SECRET);
    expect(yield* files.readlink("/escape")).toBe(`${outside}/secret.txt`);
  });

  it("reaches nothing through an ancestor link that leaves the attempt", function* () {
    const { files, attempt, outside } = yield* scene();
    yield* until(symlink(outside, `${attempt}/door`));
    yield* until(symlink("../..", `${attempt}/up`));

    for (const path of ["/door/secret.txt", "/up/anything"]) {
      expect(yield* refusal(files.readTextFile(path))).not.toContain("the file outside");
      yield* refusal(files.writeFile(path, "created\n"));
      yield* refusal(files.mkdir(path, { recursive: true }));
      yield* refusal(files.remove(path));
      yield* refusal(files.chmod(path, 0o600));
      yield* refusal(files.rename("/docs/inside.txt", path));
      yield* refusal(files.link("/docs/inside.txt", path));
    }
    expect(yield* until(readFile(`${outside}/secret.txt`, "utf8"))).toBe(SECRET);
    // And the file that was there to move is still where it was.
    expect(yield* files.readTextFile("/docs/inside.txt")).toBe("inside\n");
  });

  it("contains both ends of a rename and a hardlink", function* () {
    const { files, attempt, outside } = yield* scene();
    yield* until(symlink(outside, `${attempt}/door`));

    expect(yield* refusal(files.rename("/docs/inside.txt", "/../moved"))).toContain(
      "outside the tree",
    );
    expect(yield* refusal(files.link("/docs/inside.txt", "/../linked"))).toContain(
      "outside the tree",
    );
    yield* refusal(files.rename("/door/secret.txt", "/taken"));
    yield* refusal(files.link("/door/secret.txt", "/taken"));
    // Nothing arrived, and nothing left.
    expect(yield* refusal(files.readTextFile("/taken"))).not.toContain("the file outside");
    expect(yield* files.readTextFile("/docs/inside.txt")).toBe("inside\n");
  });

  it("does not turn a dangling outward link into a way to write outside", function* () {
    const { files, attempt, outside } = yield* scene();
    yield* until(symlink(`${outside}/absent.txt`, `${attempt}/dangling`));
    yield* refusal(files.writeFile("/dangling", "created outside\n"));
    // Nothing was created where the link pointed.
    expect(yield* refusal(until(readFile(`${outside}/absent.txt`, "utf8")))).toContain("ENOENT");
    // The link is still exactly what it was.
    expect(yield* files.readlink("/dangling")).toBe(`${outside}/absent.txt`);
  });

  it("admits an ordinary name beginning with two dots, and refuses a whole segment", function* () {
    const { files } = yield* scene();
    yield* files.writeFile("/..notes.md", "two dots is a name\n", 0o644);
    expect(yield* files.readTextFile("/..notes.md")).toBe("two dots is a name\n");
    expect(yield* files.readTextFile("/docs/../..notes.md")).toBe("two dots is a name\n");

    for (const path of ["/..", "/../escaped", "/docs/../../escaped", ""]) {
      expect([path, yield* refusal(files.writeFile(path, "no"))]).toEqual([
        path,
        expect.stringContaining("outside the tree this invocation owns"),
      ]);
    }
  });

  it("says nothing about the host in what it refuses with", function* () {
    const { files, attempt, outside } = yield* scene();
    yield* until(symlink(`${outside}/secret.txt`, `${attempt}/escape`));
    const reported = [
      yield* refusal(files.readTextFile("/escape")),
      yield* refusal(files.readTextFile("/../escaped")),
      yield* refusal(files.readTextFile("/docs/absent.txt")),
    ].join("\n");
    // Not where this invocation put its tree, and not where a link pointed.
    expect(reported).not.toContain(attempt);
    expect(reported).not.toContain(outside);
    expect(reported).not.toContain("secret.txt");
  });
});
