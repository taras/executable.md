/**
 * Untyped JavaScript boundary fixture. Models a Plugin loaded from a plain
 * JavaScript module that composes one of the Plugin APIs with a value of the
 * wrong type — the case the TypeScript types forbid, and the case the runtime
 * readers must still refuse. Deliberately untyped so the invalid value reaches
 * the validated operation without any TypeScript assertion in the test.
 */
import { Document, RootMetadata } from "@executablemd/core/api";

export function* installInvalidDocument(value) {
  yield* Document.around({
    *document() {
      return value;
    },
  });
}

export function* installInvalidRootMetadata(value) {
  yield* RootMetadata.around({ metadata: () => value });
}
