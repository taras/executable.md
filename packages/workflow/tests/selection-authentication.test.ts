/**
 * What a Repository selection can and cannot do (#643).
 *
 * A selection is composition data: a document may bind one, render one, hand
 * one to a child, and — since it is an ordinary frozen object — build one that
 * looks exactly like it. So the seam this suite guards is that naming a target
 * and being allowed to reach it are different things. The registry keeps the
 * authority; the value keeps only the name.
 *
 * Every case here is a *refusal* that must happen. A registry that answered a
 * forged selection, or one whose members were edited after it was minted, would
 * act on the provider's own record while the caller believed it named something
 * else — which is the confusion a selection exists not to be able to cause.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { selectionRegistry } from "../src/deno/selections.ts";
import {
  REPOSITORY_IDENTITY_MEMBERS,
  repositorySelection,
  type RepositoryIdentity,
} from "../src/composition/selection.ts";

const IDENTITY: RepositoryIdentity = Object.freeze({
  name: "project",
  locatorFingerprint: "fingerprint",
  requestedBase: null,
  creationCommit: "0".repeat(40),
  primaryBranch: "main",
  objectFormat: "sha1",
});

/** A registry holding one minted selection, and what it was minted for. */
function held() {
  const registry = selectionRegistry<string>();
  const selection = registry.mint("key", "project", IDENTITY, "/checkout", "held value");
  return { registry, selection };
}

/** What the registry throws when it does not recognize a selection. */
function refusal(): Error {
  return new Error("refused");
}

describe("a Repository selection names a target and carries no authority", () => {
  it("answers a selection the registry itself minted", function* () {
    const { registry, selection } = held();
    expect(registry.authenticate(selection, refusal)).toBe("held value");
  });

  it("refuses one it never minted, however well-formed", function* () {
    const { registry } = held();
    // Structurally a selection in every respect. Built rather than handed out,
    // which is the only difference and the whole of the difference.
    const forged = repositorySelection(
      "00000000-0000-4000-8000-000000000000",
      "project",
      IDENTITY,
      "/checkout",
    );
    expect(() => registry.authenticate(forged, refusal)).toThrow("refused");
  });

  it("refuses one whose name was edited after it was minted", function* () {
    const { registry, selection } = held();
    const edited = repositorySelection(
      selection.selection,
      "other",
      selection.identity,
      selection.checkoutPath,
    );
    expect(() => registry.authenticate(edited, refusal)).toThrow("refused");
  });

  it("refuses one whose checkout path was edited after it was minted", function* () {
    const { registry, selection } = held();
    const edited = repositorySelection(
      selection.selection,
      selection.name,
      selection.identity,
      "/elsewhere",
    );
    expect(() => registry.authenticate(edited, refusal)).toThrow("refused");
  });

  it("refuses when any single member of the identity was edited", function* () {
    // The comparison is total rather than a spot check, so this walks every
    // member: a registry that compared only the fingerprint would pass three of
    // these four and still be wrong.
    const { registry, selection } = held();
    const edits: RepositoryIdentity[] = [
      { ...IDENTITY, name: "another" },
      { ...IDENTITY, locatorFingerprint: "another" },
      { ...IDENTITY, requestedBase: "v1" },
      { ...IDENTITY, creationCommit: "1".repeat(40) },
      { ...IDENTITY, primaryBranch: "trunk" },
      { ...IDENTITY, objectFormat: "sha256" },
    ];
    // One per member of REPOSITORY_IDENTITY_MEMBERS, so a registry that
    // compared any proper subset would pass some of these and still be wrong.
    expect(edits).toHaveLength(REPOSITORY_IDENTITY_MEMBERS.length);
    for (const identity of edits) {
      const edited = repositorySelection(
        selection.selection,
        selection.name,
        identity,
        selection.checkoutPath,
      );
      expect(() => registry.authenticate(edited, refusal)).toThrow("refused");
    }
  });

  it("does not let one registry's selection authorize another's", function* () {
    // Two providers in one process, or a parent and an isolated child: a
    // selection is only ever good at the registry that minted it.
    const first = held();
    const second = selectionRegistry<string>();
    second.mint("key", "project", IDENTITY, "/checkout", "the other value");
    expect(() => second.authenticate(first.selection, refusal)).toThrow("refused");
  });
});
