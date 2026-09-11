/**
 * The pure half of canonicalization, and the host-capable half beside it.
 *
 * `canonicalize()` moved into a leaf so a runtime without Node builtins can
 * reach it — a Cloudflare Worker validating a retained record needs the key
 * ordering and not the digest. The risk in that move is two implementations
 * that drift, so what is asserted here is that there is exactly one: the
 * package root and the subpath answer identically, and the fingerprint that
 * composes over it is unchanged.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { canonicalize as fromRoot, canonicalFingerprint } from "@executablemd/core";
import { canonicalize as fromSubpath } from "@executablemd/core/canonicalize";
import { isComponentName as componentNameFromRoot } from "@executablemd/core";
import { isComponentName as componentNameFromSubpath } from "@executablemd/core/component-name";
import { isCanonicalDocumentTarget as targetFromRoot } from "@executablemd/core";
import { isCanonicalDocumentTarget as targetFromSubpath } from "@executablemd/core/document-target";
import type { Json } from "@executablemd/core";

/** Values chosen for the properties canonicalization is about. */
const VALUES: Json[] = [
  null,
  0,
  "text",
  [3, 1, 2],
  { b: 1, a: 2 },
  { outer: { z: [{ y: 1, x: 2 }], a: null } },
  // The name whose ordinary assignment would reach `Object.prototype`.
  { ["__proto__"]: { polluted: true }, after: 1 },
];

describe("canonicalization through both paths", () => {
  it("answers identically from the package root and the subpath", function* () {
    for (const value of VALUES) {
      expect(JSON.stringify(fromSubpath(value))).toEqual(JSON.stringify(fromRoot(value)));
    }
  });

  it("still sorts keys and leaves arrays in order", function* () {
    expect(JSON.stringify(fromSubpath({ b: 1, a: 2 }))).toEqual('{"a":2,"b":1}');
    expect(JSON.stringify(fromSubpath([3, 1, 2]))).toEqual("[3,1,2]");
  });

  it("keeps the fingerprint composing over the same ordering", function* () {
    // The digest is the half that needs a host; it is unchanged by the split.
    expect(canonicalFingerprint({ b: 1, a: 2 })).toEqual(canonicalFingerprint({ a: 2, b: 1 }));
    expect(canonicalFingerprint({ a: 1 })).not.toEqual(canonicalFingerprint({ a: 2 }));
    expect(canonicalFingerprint({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the other predicates a retained descriptor validates with", () => {
  it("answers identically from the package root and the subpath", function* () {
    for (const name of ["Repository", "Ns.Sub", "lower", "", "9Bad", "A_1"]) {
      expect(componentNameFromSubpath(name)).toEqual(componentNameFromRoot(name));
    }
    for (const target of ["Heading", "A/B", "", "a%2Fb", "Lower case", "%2f", "Tab\there"]) {
      expect(targetFromSubpath(target)).toEqual(targetFromRoot(target));
    }
  });
});
