/**
 * The three filesystem components canonical core claims the names of
 * (spec §§6.13, 6.13.1, 6.13.2).
 *
 * `<File>`, `<File.Delete>` and `<Dir>` read, write, remove and enter paths. A
 * document that names one has named an effect on the author's own filesystem,
 * so what those three names mean cannot be something a repository, a host or a
 * bundle decides: a `File.md` beside the document would otherwise choose what
 * `<File>` writes, under a name every author already reads as core's.
 *
 * They are therefore in the protected tier (`protected.ts`) rather than the
 * replaceable registry. What stays replaceable is the *provider*: `API.Files`
 * middleware still answers, transforms, delegates and refuses every operation
 * these bodies perform, because which filesystem a run reaches — the caller's
 * own, a workflow run's transaction-bound logical one — was never these
 * components' decision.
 *
 * ## Why they are not built per execution
 *
 * The other two protected components are. `<Syntax />` and `<Evaluate>` are
 * handed a site canonical execution built for them, so their bodies exist only
 * once that execution does. These three need nothing of the kind: each one is
 * an ordinary component whose body reaches the filesystem through contextual
 * operations, and the only engine-owned part is the dispatcher that decides
 * which authored form it was written as. So each definition is built once per
 * loaded copy of core, exactly as the registry builds its own, and the
 * execution's protected table answers with this object rather than a rebuilt
 * one.
 *
 * One source for all three, because there are two consumers who must agree: the
 * protected tier the engine resolves them through, and the generated-XMD write
 * table that pins `<File>`'s two spellings and `<File.Delete>`'s one
 * (`generated-xmd.ts`). A second copy of a definition would be a second
 * component, and the drift would be invisible until a generated fragment
 * behaved differently from an authored element.
 */

import { form as dirForm, props as dirProps } from "./Dir.ts";
import { form as fileForm, props as fileProps } from "./File.ts";
import { form as fileDeleteForm, props as fileDeleteProps } from "./FileDelete.ts";
import { declaredForms, formDispatcher } from "../invocation-identity.ts";
import { parseJsonObject } from "../json.ts";
import { documented } from "./documentation.ts";
import { CORE_ORIGIN } from "./registry.ts";
import type { FirstPartyDocumentation } from "./documentation.ts";
import type { FormDeclaration } from "../invocation-identity.ts";
import type { FunctionComponentDefinition, PropsSchema } from "../types.ts";

/**
 * One fixed component, normalized the way a core default is.
 *
 * The dispatcher and the accepted forms both come from the one declaration the
 * component exports, so what it dispatches and what inspection reports cannot
 * disagree. Documentation is a parameter for the same reason it is one in the
 * registry: a component core supplies states what it is for, and says whether
 * `as` and content apply to it.
 *
 * **Frozen, and that is load-bearing.** This object is what the public
 * `Component.importComponent` chain is handed, and it is shared by every
 * execution in the process. Canonical verification compares each answer against
 * the copy taken when the definition was first issued *to that execution*
 * (`component-resolution.ts`), which is enough to refuse a change inside the
 * execution that made it — but a change left behind would be what the next
 * execution took its own first copy of, and that one would describe the change
 * already. Freezing is what the sharing requires, and it covers the descriptive
 * members for the same reason it covers `fn`: a changed schema or form list
 * decides what runs too.
 */
function fixed(
  name: string,
  declaration: FormDeclaration,
  props: PropsSchema,
  documentation: FirstPartyDocumentation,
): FunctionComponentDefinition {
  return Object.freeze({
    kind: "function",
    name,
    props,
    forms: Object.freeze(declaredForms(declaration)),
    ...documented(documentation),
    fn: formDispatcher(declaration),
  });
}

/** The definitions themselves, in the order inspection reads them. */
const DEFINITIONS: readonly FunctionComponentDefinition[] = Object.freeze([
  fixed("File", fileForm, parseJsonObject(fileProps), {
    description:
      'Read or write a file. `<File path="notes.md" />` reads the content; ' +
      '`<File path="notes.md">…</File>` writes the content. The path is relative to the ' +
      "working directory.",
    as: "Optional. Captures the file's text instead of emitting it, in the reading form.",
    context: "The text to write, in the writing form.",
  }),
  fixed("File.Delete", fileDeleteForm, parseJsonObject(fileDeleteProps), {
    description:
      'Delete a file. `<File.Delete path="notes.md" />` removes it. It does not error if the ' +
      "file doesn't exist, and produces no output.",
    as: "Optional. Captures the empty string this renders, as for any text component.",
    context: null,
  }),
  fixed("Dir", dirForm, parseJsonObject(dirProps), {
    description:
      'Create or use a directory. `<Dir path="notes">…</Dir>` changes the working directory ' +
      "for its content.",
    as: null,
    context: "The Markdown expanded in that directory.",
  }),
]);

const BY_NAME: ReadonlyMap<string, FunctionComponentDefinition> = new Map(
  DEFINITIONS.map((definition) => [definition.name, definition]),
);

/** Every definition this module owns, for the protected tier that answers with them. */
export const FIXED_FILESYSTEM_DEFINITIONS = DEFINITIONS;

/** The origin these components report, which is core's own. */
export const FIXED_FILESYSTEM_ORIGIN = CORE_ORIGIN;

/**
 * The one definition this name resolves to, or nothing when it is not one of
 * the three.
 *
 * The generated-XMD write table asks for this rather than reaching into a
 * registry: a pinned identity has to name the exact object the engine invokes,
 * and these are no longer registry entries.
 */
export function fixedFilesystemDefinition(name: string): FunctionComponentDefinition | undefined {
  return BY_NAME.get(name);
}
