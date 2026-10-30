import fs from "node:fs";
type BuiltInAgentPackageSpec = {
  packageName: string;
  packageRange: string;
  preferredBinName: string;
  fallbackCommand: string;
  legacyFallbackCommands?: string[];
};
type BuiltInAgentLaunch = {
  source: "installed" | "package-exec";
  command: string;
  args: string[];
  packageName: string;
  packageRange: string;
  packageVersion?: string;
  binPath?: string;
  npmCliPath?: string;
};
type BuiltInLaunchResolverOptions = {
  existsSync?: (path: string) => boolean;
  readFileSync?: typeof fs.readFileSync;
  resolvePackageRoot?: (packageName: string) => string | undefined;
  execPath?: string;
  resolveNpmCliPath?: (execPath: string) => string;
};
export declare const AGENT_ARGV_REGISTRY: Record<string, string[]>;
export declare const AGENT_REGISTRY: Record<string, string>;
export declare const BUILT_IN_AGENT_PACKAGES: Record<string, BuiltInAgentPackageSpec>;
export type AcpAgentInspection = {
  id: string;
  name: string;
  launch: {
    kind: "installed";
    argv: string[];
  } | {
    kind: "missing";
    requirements: Array<{
      kind: "command" | "package";
      name: string;
    }>;
  };
};
export type AcpAgentInspectionOptions = {
  resolveExecutable?: (command: string) => string | undefined;
  resolvePackageRoot?: (packageName: string) => string | undefined;
};
export declare const DEFAULT_AGENT_NAME = "codex";
export declare function normalizeAgentName(value: string): string;
export declare function resolveCanonicalAgentName(value: string): string;
export declare function mergeAgentRegistry(overrides?: Record<string, string>): Record<string, string>;
export declare function resolveAgentCommand(agentName: string, overrides?: Record<string, string>): string;
export declare function resolveAgentArgv(agentName: string): string[] | undefined;
export declare function findBuiltInAgentPackage(agentCommand: string): BuiltInAgentPackageSpec | undefined;
export declare function resolveInstalledBuiltInAgentLaunch(agentCommand: string, options?: BuiltInLaunchResolverOptions): BuiltInAgentLaunch | undefined;
export declare function resolvePackageExecBuiltInAgentLaunch(agentCommand: string, options?: BuiltInLaunchResolverOptions): BuiltInAgentLaunch | undefined;
export declare function resolveBuiltInAgentLaunch(agentCommand: string, options?: BuiltInLaunchResolverOptions): BuiltInAgentLaunch | undefined;
export declare function listBuiltInAgents(overrides?: Record<string, unknown>): string[];
export interface AcpAgentRegistry {
  resolve(agentName: string): string | string[];
  list(): string[];
}
export type AcpInspectableAgentRegistry = AcpAgentRegistry & {
  inspect(agentId: string): AcpAgentInspection | undefined;
};
export declare function createAgentRegistry(params?: {
  overrides?: Record<string, string | string[]>;
} & AcpAgentInspectionOptions): AcpInspectableAgentRegistry;
export {};
//# sourceMappingURL=agent-registry.d.ts.map