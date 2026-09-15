// Reads the typed configuration the command already settled, and says so. The
// four values are `Config`'s own: the run deadline, the exec default, the Fetch
// default and contextual verbosity. A root property spelled like a CLI option
// reaches document props and reaches none of these.
import { Document, Plugin } from "@executablemd/core/api";
import { timeout, timeoutExec, timeoutFetch, verbose } from "@executablemd/runtime/api";

export default Plugin({
  name: "configured",
  *install() {
    const settled = [
      `verbose: ${yield* verbose}`,
      `timeout: ${yield* timeout}`,
      `timeoutExec: ${yield* timeoutExec}`,
      `timeoutFetch: ${yield* timeoutFetch}`,
    ].join("\n");
    yield* Document.around({
      *document(_args, next) {
        return `${settled}\n\n${yield* next()}`;
      },
    });
    return undefined;
  },
});
