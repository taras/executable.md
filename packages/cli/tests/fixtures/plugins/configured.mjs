// Reads the typed configuration the command already settled, and says so. A
// root property spelled like a CLI option reaches document props and changes
// nothing here.
import { Document, Plugin } from "@executablemd/core/api";
import { verbose } from "@executablemd/runtime/api";

export default Plugin({
  name: "configured",
  *install() {
    const configured = yield* verbose;
    yield* Document.around({
      document: (_args, next) => `verbose: ${configured}\n\n${next()}`,
    });
    return undefined;
  },
});
