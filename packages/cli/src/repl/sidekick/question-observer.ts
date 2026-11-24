import { createContext } from "effection";
import type { ResponseAt } from "./owner.ts";

export type SidekickQuestionIdentity = ResponseAt & { readonly turn: number };

export const SidekickQuestionObserver = createContext<(at: SidekickQuestionIdentity) => void>(
  "xmd.repl.sidekick.question-observer",
);
