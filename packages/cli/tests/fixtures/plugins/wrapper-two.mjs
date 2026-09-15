import { Document, Plugin } from "@executablemd/core/api";

export default Plugin({
  name: "wrapper-two",
  *install() {
    yield* Document.around({
      *document(_args, next) {
        return `two open\n\n${yield* next()}\n\ntwo close\n`;
      },
    });
    return undefined;
  },
});
