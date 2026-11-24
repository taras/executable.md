import { ensure, type Operation } from "effection";
import {
  SidekickQuestionObserver,
  type SidekickQuestionIdentity,
} from "../../../packages/cli/src/repl/sidekick/question-observer.ts";
import { ReplTerminal } from "../../../packages/cli/src/repl/terminal.ts";
import {
  answerLabel,
  answerTiming,
  answerTimingEnvironment,
  macSystemLibrary,
  monotonicRaw,
} from "./answer-timing.ts";

export function* installAnswerTiming(): Operation<void> {
  const path = Deno.env.get(answerTimingEnvironment);
  if (path === undefined || Deno.build.os !== "darwin") {
    return;
  }

  const library = Deno.dlopen(macSystemLibrary, {
    clock_gettime_nsec_np: { parameters: ["u32"], result: "u64" },
  });
  yield* ensure(() => library.close());
  const record = answerTiming(path, () => library.symbols.clock_gettime_nsec_np(monotonicRaw));
  const decode = new TextDecoder();
  let registered: SidekickQuestionIdentity | undefined;
  yield* SidekickQuestionObserver.set((at) => {
    registered = at;
    record({ event: "registered", ...at });
  });
  yield* ReplTerminal.around({
    *write([bytes], next) {
      const at = registered;
      if (at === undefined || !decode.decode(bytes).includes(answerLabel)) {
        return yield* next(bytes);
      }
      record({ event: "frame-write-start", ...at });
      yield* next(bytes);
      record({ event: "frame-write-end", ...at });
    },
  });
}
