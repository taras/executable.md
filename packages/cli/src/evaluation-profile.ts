/**
 * What `xmd run` offers a generated fragment, as ordinary Component middleware.
 *
 * `<Evaluate>` is public and canonical core owns what it means, so this file
 * does not decide the component — it decides the *selection*, which is the only
 * part a host owns. It is stated here, at the assembly this command already
 * does, in the scope that will execute the document.
 *
 * ## What is selected
 *
 * Names and authored forms, and nothing else:
 *
 * ```ts
 * {
 *   File: ["self-closing", "paired"],
 *   "File.Delete": ["self-closing"],
 *   Glob: ["self-closing"],
 *   Syntax: ["self-closing"],
 *   Elicit: ["paired"],
 * }
 * ```
 *
 * Core resolves each of those names once, before public execution policy, and
 * reads the identity, the effect and the contract of every selected spelling
 * off the declaration that owns the implementation. So reading and writing stay
 * separate spellings of one name — `allow={["read"]}` admits `<File />` and not
 * `<File>…</File>` — without this file saying anything about what either does.
 *
 * `<Elicit>` is selected paired: a fragment that may change something may also
 * ask the person first, which is what makes "preview this, then confirm it" a
 * program an Agent can write. Its owner offers the paired form as a write, so a
 * `read` selection admits no question and promises nobody will be interrupted.
 *
 * `Dir` and `Fetch` are absent rather than present-and-bounded. An ordinary run
 * creates no directory and reads no network on a document's behalf, and
 * selecting a name a fragment could never usefully call would tell an agent it
 * had something it does not.
 *
 * ## It states no filesystem of its own
 *
 * A selected name runs the implementation canonical resolution answered with,
 * which performs its operation through contextual `API.Files` — the provider
 * this command's entrypoint installed, and the same one every authored `<File>`
 * in the document crosses. So a fragment's read is observed, transformed,
 * delegated and refused by exactly the middleware an author's read is, and the
 * effective `Permissions` of the scope it runs in decide it.
 *
 * ## Delegate first, default only on absence
 *
 * This is ordinary property middleware: it asks what the scope around it
 * already offers and supplies the selection above only when that answer is
 * `undefined`. A host that stated its own — a workflow attachment, a test
 * harness, a plugin — keeps it, and a defined answer that is empty or malformed
 * is preserved for core to refuse rather than quietly replaced with this one.
 * Two handlers compose normally; there is no contributor count, no automatic
 * union and no installation-array inspection.
 *
 * `useGeneratedFallback()` is that rule, and every ordinary host that supplies a
 * default goes through it — this command, each REPL entry, an isolated run
 * child. A host that answered instead would be the one place a plugin's or a
 * captured installation callback's selection could not be read, which is the
 * same as not composing at all.
 */

import { Component } from "@executablemd/core/api";
import type { GeneratedSelection } from "@executablemd/core/api";
import type { Operation } from "effection";

/** The names and forms `xmd run` and its run children offer. */
export function ordinaryGeneratedSelection(): GeneratedSelection {
  return {
    File: ["self-closing", "paired"],
    "File.Delete": ["self-closing"],
    Glob: ["self-closing"],
    Syntax: ["self-closing"],
    Elicit: ["paired"],
  };
}

/**
 * Offer this selection for this scope, unless something nearer already offers
 * one.
 *
 * Installed where the document will execute. Installing it in a scope that ends
 * before the execution would leave the middleware chain core reads composed of
 * handlers that are no longer there.
 *
 * The composition rule lives here rather than at each caller, so a host that
 * supplies a default of its own supplies it the same way.
 */
export function useGeneratedFallback(selection: GeneratedSelection): Operation<void> {
  return Component.around({
    // A value member, so the chain is synchronous: `next()` answers with what
    // the scope around this already offers, and only absence defaults. An empty
    // or malformed selection is a host statement core validates and refuses;
    // replacing it here would answer a host's mistake with this command's
    // permission.
    generated: (_args, next) => {
      const stated = next();
      return stated === undefined ? selection : stated;
    },
  });
}

/** Offer the ordinary selection, unless something nearer already offers one. */
export function useOrdinaryGeneratedSelection(): Operation<void> {
  return useGeneratedFallback(ordinaryGeneratedSelection());
}
