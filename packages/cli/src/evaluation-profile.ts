/**
 * What `xmd run` lets a generated fragment do.
 *
 * `<Evaluate>` is public and canonical core owns what it means, so this file
 * does not decide the component — it decides the *ceiling*, which is the only
 * part a host owns. It is stated here, at the assembly this command already
 * does, before any document exists to ask for it.
 *
 * ## Composition and effect tables
 *
 * Pure composition always includes exact core `<Json />`. `read` is core's
 * self-closing `<File />`. `write` is core's
 * paired `<File>…</File>` and self-closing `<File.Delete />`. A fragment run by
 * `xmd run` therefore reaches the caller's own filesystem through the Files
 * provider this command installed, and reaches nothing else at all: no network
 * read, no process, no repository, no Git, no credential and no agent.
 *
 * `<Fetch>` is absent rather than present-and-bounded. An unbounded network
 * read is a decision this command does not make on a document's behalf, and
 * admitting the identity with an empty ceiling would be a different thing from
 * not admitting it — the fragment would name a component it can never
 * successfully call.
 *
 * ## No Workspace, and no alias
 *
 * An ordinary run evaluates against no Workspace. Its admitted effects address
 * the Files provider its own execution installed, and there is no immutable
 * root history for a continuation to be held to — which is a different
 * statement from evaluating against an empty one, and the profile says so by
 * omitting the access rather than answering it with nothing.
 *
 * It accepts `text` and refuses `source`: `xmd run` never shipped the earlier
 * spelling, so there is no document written against it to keep working.
 */

import {
  fileDeleteEntry,
  fileReadEntry,
  fileWriteEntry,
  jsonCompositionEntry,
} from "@executablemd/core/host";
import type {
  ExecutionInstallation,
  FragmentEvaluationInput,
  FragmentFileAccess,
} from "@executablemd/core/host";
import { cwd, hostFilesHandler } from "@executablemd/runtime";

/**
 * The exact filesystem operations an admitted fragment performs.
 *
 * A handler of this command's own, constructed here rather than read from
 * `API.Files` when a fragment runs. The document's provider and this one behave
 * identically — both are `hostFilesHandler()` — and the difference is that
 * nothing a document, a repository component or middleware installs is between
 * a fragment and this instance.
 *
 * Only the five operations a fragment can name are copied across. The handler
 * also offers globbing and temporary directories; an admitted fragment has
 * neither, and not copying them is what makes that true.
 */
function ordinaryFiles(): FragmentFileAccess {
  const handler = hostFilesHandler();
  return {
    checkFilePath: (input) => handler.checkFilePath(input),
    readTextFile: (input) => handler.readTextFile(input),
    writeTextFile: (input) => handler.writeTextFile(input),
    deleteFile: (input) => handler.deleteFile(input),
    ensureDirectory: (input) => handler.ensureDirectory(input),
    // The caller's working directory, which is what `xmd run` resolves every
    // authored path against. Read when a fragment runs rather than frozen at
    // assembly, so a fragment and the document that produced it resolve the
    // same relative path to the same file.
    workingDirectory: () => cwd(),
  };
}

/** The ceiling `xmd run` and its run children state. */
export function ordinaryEvaluationProfile(): FragmentEvaluationInput {
  return {
    composition: [jsonCompositionEntry()],
    read: [fileReadEntry()],
    write: [fileWriteEntry(), fileDeleteEntry()],
    files: ordinaryFiles(),
  };
}

/**
 * Whether the host that attached this execution already stated a ceiling.
 *
 * One execution offers one maximum authority, so a workflow attachment — which
 * states its own Workspace-bound profile — is not also given the run profile's.
 * Asked about the installations rather than resolved by order, because
 * "whichever came last wins" is exactly how authority stops being auditable.
 */
export function statesEvaluation(
  installations: readonly ExecutionInstallation[] | undefined,
): boolean {
  return (installations ?? []).some((installation) => installation.evaluation !== undefined);
}
