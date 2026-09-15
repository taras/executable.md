import { Document, Plugin } from "@executablemd/core/api";

export default Plugin({
  name: "wrapper-two",
  *install() {
    yield* Document.around({
      document: (_args, next) => `two open\n\n${next()}\n\ntwo close\n`,
    });
    return undefined;
  },
});
