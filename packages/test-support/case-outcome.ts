import { createContext } from "effection";
import type { Operation } from "effection";

export interface CaseSetup {
  setup(): Operation<void>;
}

export interface SettledCase {
  name: string;
  suite: string;
  save?: () => Operation<void>;
}

export const CaseOutcome = createContext<SettledCase>("@executablemd/test-support/case-outcome");
