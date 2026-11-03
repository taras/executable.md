import { createContext } from "effection";
import type { Configuration, Report } from "./report.ts";

export interface QualificationState {
  configuration: Configuration;
  report: Report;
  marker: string;
  failure?: Error;
}
export const Qualification = createContext<QualificationState>(
  "executablemd.agent-certification/observations",
);
