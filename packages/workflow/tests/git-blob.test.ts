/**
 * Naming a blob the way Git names one.
 *
 * A workflow definition holds each bundled component's object id, and a
 * completed replay has no repository to ask what a retained source hashes to.
 * So it computes the name itself — which is only worth anything if the name it
 * computes is Git's. Two authorities settle that here, and neither of them is
 * this code: FIPS 180-4's published SHA-1 answers, and the object ids
 * `git hash-object -t blob` gave these exact bytes.
 *
 * The object ids are committed constants rather than a computation. Deriving
 * them from the function under test would be a test agreeing with itself, and
 * shelling out to Git would make a portable suite depend on a program. The
 * end-to-end proof that this agrees with a real repository is
 * `packages/cli/tests/workflow-replay.test.ts`, where the definition's hashes
 * come from `git rev-parse` and this admission authenticates against them.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { gitBlobId, sha1Hex } from "../src/git-blob.ts";

/** Eight UTF-16 units, eleven bytes: `é` is two and the dragon is four. */
const WIDE = "café \u{1f409}\n";

describe("SHA-1, held to its published answers", () => {
  // deno-lint-ignore require-yield
  it("reproduces the FIPS 180-4 examples", function* () {
    expect(sha1Hex("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(sha1Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "84983e441c3bd26ebaae4aa1f95129e5e54670f1",
    );
    expect(sha1Hex("")).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    // A million `a`s is the third published example; this is the block-boundary
    // half of what it exercises, at a size a test can carry.
    expect(sha1Hex("a".repeat(1000))).toBe("291e9a6c66994949b57ba5e650361e98fc36b1ba");
  });

  // deno-lint-ignore require-yield
  it("hashes bytes, not characters", function* () {
    expect(sha1Hex(WIDE)).toBe(sha1Hex(new TextEncoder().encode(WIDE)));
  });
});

describe("the object id a blob has", () => {
  // deno-lint-ignore require-yield
  it("is the one Git gives it, under either object format", function* () {
    expect(gitBlobId("staged.\n", "sha1")).toBe("4eb53b7fd720524e22040757b43e821f817ff0eb");
    expect(gitBlobId("staged.\n", "sha256")).toBe(
      "bee278bf729e0ac11f0bd6bf2ec94b1536d51883bd6e426ac32ec0a94afe76ca",
    );
    expect(gitBlobId("never imported.\n", "sha1")).toBe("0b42d358385c85db1957138c7a200ad153514209");
    expect(gitBlobId("", "sha1")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  // deno-lint-ignore require-yield
  it("frames the header with the encoded byte length", function* () {
    // Eleven bytes, eight units of `String#length`. A framing that used the
    // string length would write `blob 8` and name an object Git does not.
    expect(new TextEncoder().encode(WIDE).length).toBe(11);
    expect(WIDE.length).toBe(8);
    expect(gitBlobId(WIDE, "sha1")).toBe("c4ae463ec163e7b0b1a47ca6f0d5a2205d3643dc");
    expect(gitBlobId(WIDE, "sha256")).toBe(
      "3a2a85ffaa00d300e360a8f0e3b0d1b13e6bcdabfdcd8124d2f2e3dc062cc9f5",
    );
  });

  // deno-lint-ignore require-yield
  it("names different bytes differently", function* () {
    expect(gitBlobId("ALTERED\n", "sha1")).toBe("e93f6b023845f2035a5f3d299ae4624802b4e891");
    expect(gitBlobId("ALTERED\n", "sha1")).not.toBe(gitBlobId("staged.\n", "sha1"));
    // The framing is what keeps content from being confused with its own
    // header: these are not the same object.
    expect(gitBlobId("staged.\n", "sha1")).not.toBe(sha1Hex("staged.\n"));
  });
});
