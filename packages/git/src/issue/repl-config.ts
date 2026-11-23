import { createContext } from "effection";

export const ReplGitHubBaseUrl = createContext<string | undefined>(
  "executablemd.git.replGitHubBaseUrl",
);
