import { useRunComposition } from "@executablemd/git/deno";
export function useArtifactReturnHost(root: string, repository: string) {
  return useRunComposition({ root: root + "/managed", cwd: repository });
}
