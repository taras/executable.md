import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { ExecutableMetadata, ExecutableMetadataObservation } from "@executablemd/runtime";
import {
  ADVERTISED_CLIENT_NATIVE_ATTACHMENT,
  ADVERTISED_NATIVE_LAUNCH,
  ADVERTISED_PROVIDER_NATIVE_CONTINUATION,
  bindsBuild,
  nativeAdapterFor,
  nativeCapabilityPolicy,
  pinnedProviderRouteProtocol,
  pinnedRouteProtocol,
} from "../src/native-launch.ts";
import type { NativeCapability, NativeCapabilityPolicy } from "../src/native-capability.ts";
import { admitsNativeCapability } from "../src/native-capability.ts";

const ROOT_HELP = `Codex CLI

Usage: codex [OPTIONS] [PROMPT]
       codex [OPTIONS] <COMMAND> [ARGS]

Commands:
  exec    Run Codex non-interactively
  resume  Resume a previous interactive session (picker by default)
  help    Print this message

Arguments:
  [PROMPT]
          Optional user prompt to start the session

Options:
  -h, --help
          Print help
`;

const RESUME_HELP = `Resume a previous interactive session

Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]

Arguments:
  [SESSION_ID]
          Session id (UUID) or session name. UUIDs take precedence if it parses.
          If omitted, use --last to pick the most recent recorded session

  [PROMPT]
          Optional user prompt to start the session

Options:
      --last
          Continue the most recent session
  -h, --help
          Print help
`;

function answered(stdout: string): ExecutableMetadataObservation {
  return { settled: true, code: 0, stdout, stderr: "" };
}

function metadata(
  root = ROOT_HELP,
  resume = RESUME_HELP,
  version = "codex-cli 0.153.2",
): ExecutableMetadata {
  return { help: answered(root), "resume-help": answered(resume), version: answered(version) };
}

function codexAdapter() {
  const adapter = nativeAdapterFor("codex");
  if (adapter === undefined || !bindsBuild(adapter)) {
    throw new Error("the Codex adapter must observe its executable");
  }
  return adapter;
}

const CAPABILITIES: readonly NativeCapability[] = ["native-launch", "provider-native-continuation"];

describe("Tier CDP — Codex capability admission", () => {
  it("CDP1: the built-in adapter names the exact provider-returned command and bridge contract", function* () {
    const adapter = codexAdapter();
    expect(adapter.identity).toBe("provider-returned");
    expect(adapter.protocol).toBe("codex-provider-returned.v1");
    expect(adapter.binding.metadata).toEqual([
      { name: "help", args: ["--help"] },
      { name: "resume-help", args: ["resume", "--help"] },
      { name: "version", args: ["--version"] },
    ]);
    expect(adapter.binding.environment("/canonical/codex")).toEqual({
      CODEX_PATH: "/canonical/codex",
    });
    expect(adapter.binding.adapterCommand).toBe(undefined);
    expect(adapter.resume("provider-issued-id")).toEqual(["codex", "resume", "provider-issued-id"]);
    expect(adapter.materialization).toEqual({
      promptVersion: "codex-materialization.v1",
      prompt:
        "This turn only makes the Codex conversation resumable. Do not perform the prepared " +
        "task, inspect or modify files, call tools, or take any external action. Reply with a " +
        "brief acknowledgement only.",
    });
    expect(ADVERTISED_NATIVE_LAUNCH).toEqual(["claude", "codex"]);
    expect(ADVERTISED_CLIENT_NATIVE_ATTACHMENT).toEqual(["claude"]);
    expect(ADVERTISED_PROVIDER_NATIVE_CONTINUATION).toEqual(["codex"]);
  });

  it("CDP2: the positive root and resume shapes survive unrelated options, wrapping and release changes", function* () {
    const binding = codexAdapter().binding;
    for (const version of [
      "codex-cli 0.153.2",
      "codex-cli 99.12.3",
      "",
      "Version wording changed",
    ]) {
      const root = ROOT_HELP.replace("  exec", "  new-command    Something new\n  exec");
      const resume = RESUME_HELP.replace(
        "[OPTIONS] [SESSION_ID] [PROMPT]",
        "[OPTIONS]\n       [SESSION_ID] [PROMPT]",
      ).replace("Session id (UUID)", "Session\n          id (UUID)");
      expect(binding.probe(metadata(root, resume, version))).toEqual({
        probeProfile: "codex-help-native-session.v1",
        capabilities: CAPABILITIES,
      });
    }
    expect(
      binding.probe({ help: answered(ROOT_HELP), "resume-help": answered(RESUME_HELP) })
        .capabilities,
    ).toEqual(CAPABILITIES);
  });

  it("CDP3: mentions, changed identity semantics and reordered positionals grant no capability", function* () {
    const cases: [string, string, string][] = [
      ["another product", ROOT_HELP.replace("Codex CLI", "Another CLI"), RESUME_HELP],
      [
        "compatibility wrapper",
        ROOT_HELP.replace("Codex CLI", "Codex CLI compatibility wrapper"),
        RESUME_HELP,
      ],
      [
        "product mentioned in an option",
        ROOT_HELP.replace("Codex CLI\n", "") + "  --compat    Codex CLI\n",
        RESUME_HELP,
      ],
      [
        "root usage names another program",
        ROOT_HELP.replace("Usage: codex", "Usage: other"),
        RESUME_HELP,
      ],
      [
        "resume mentioned but not declared",
        ROOT_HELP.replace("  resume  Resume", "  help-resume  Resume"),
        RESUME_HELP,
      ],
      [
        "duplicate resume command",
        ROOT_HELP.replace("  resume", "  resume  Another declaration\n  resume"),
        RESUME_HELP,
      ],
      [
        "another subcommand",
        ROOT_HELP,
        RESUME_HELP.replace("Usage: codex resume", "Usage: codex fork"),
      ],
      [
        "reordered usage",
        ROOT_HELP,
        RESUME_HELP.replace("[SESSION_ID] [PROMPT]", "[PROMPT] [SESSION_ID]"),
      ],
      ["renamed identity", ROOT_HELP, RESUME_HELP.replaceAll("SESSION_ID", "SESSION_NAME")],
      ["required identity", ROOT_HELP, RESUME_HELP.replaceAll("[SESSION_ID]", "<SESSION_ID>")],
      [
        "usage only mentions identity",
        ROOT_HELP,
        RESUME_HELP.replace("  [SESSION_ID]", "  [SESSION_NAME]"),
      ],
      ["identity accepts URLs", ROOT_HELP, RESUME_HELP.replace("Session id (UUID)", "Session URL")],
      [
        "identity refuses UUID",
        ROOT_HELP,
        RESUME_HELP.replace("Session id (UUID)", "Session id (UUID) is not supported"),
      ],
      [
        "UUID mentioned in another argument",
        ROOT_HELP,
        RESUME_HELP.replace("Session id (UUID)", "Session name").replace(
          "Optional user prompt",
          "Session id (UUID). Optional user prompt",
        ),
      ],
      [
        "extra positional before identity",
        ROOT_HELP,
        RESUME_HELP.replace("Arguments:\n", "Arguments:\n  [FILE]\n          A file\n"),
      ],
      [
        "duplicate identity",
        ROOT_HELP,
        RESUME_HELP.replace(
          "  [SESSION_ID]\n",
          "  [SESSION_ID]\n          Session id (UUID)\n  [SESSION_ID]\n",
        ),
      ],
      [
        "duplicate usage",
        ROOT_HELP,
        RESUME_HELP + "Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]\n",
      ],
    ];
    for (const [name, root, resume] of cases) {
      expect([name, codexAdapter().binding.probe(metadata(root, resume)).capabilities]).toEqual([
        name,
        [],
      ]);
    }
  });

  it("CDP4: missing or failed metadata is no declaration, and version evidence is optional", function* () {
    const binding = codexAdapter().binding;
    for (const name of ["help", "resume-help"]) {
      const absent = { ...metadata() };
      delete absent[name];
      expect(binding.probe(absent).capabilities).toEqual([]);
      for (const failure of [{ settled: false }, { code: 1 }]) {
        expect(
          binding.probe({ ...metadata(), [name]: { ...metadata()[name], ...failure } })
            .capabilities,
        ).toEqual([]);
      }
    }
    expect(binding.reportedVersion(metadata())).toBe("codex-cli 0.153.2");
    expect(binding.reportedVersion(metadata(ROOT_HELP, RESUME_HELP, "codex-cli 99.1.2\n"))).toBe(
      "codex-cli 99.1.2",
    );
    for (const version of [
      "",
      "0.153.2",
      "other-cli 0.153.2",
      "codex-cli 0.153.2\ncodex-cli 0.153.3",
    ]) {
      expect(binding.reportedVersion(metadata(ROOT_HELP, RESUME_HELP, version))).toBe(undefined);
    }
    expect(
      binding.reportedVersion({
        ...metadata(),
        version: { ...answered("codex-cli 0.153.2"), code: 1 },
      }),
    ).toBe(undefined);
  });

  it("CDP5: capability, protocol, profile and host are independent admission requirements", function* () {
    const adapter = codexAdapter();
    const observed = adapter.binding.probe(metadata());
    const policy = nativeCapabilityPolicy({ platform: "darwin", architecture: "arm64" });
    for (const capability of CAPABILITIES) {
      const request = {
        adapterProtocol: adapter.protocol,
        capability,
        probeProfile: observed.probeProfile,
      };
      expect(admitsNativeCapability(policy, request)).toBe(true);
      expect(admitsNativeCapability(undefined, request)).toBe(false);
      expect(
        admitsNativeCapability(policy, {
          ...request,
          adapterProtocol: "codex-provider-returned.v2",
        }),
      ).toBe(false);
      expect(
        admitsNativeCapability(policy, {
          ...request,
          probeProfile: "codex-help-native-session.v2",
        }),
      ).toBe(false);
      expect(
        admitsNativeCapability(policy, { ...request, capability: "client-native-attachment" }),
      ).toBe(false);
      for (const host of [
        { platform: "linux", architecture: "arm64" },
        { platform: "darwin", architecture: "x64" },
      ]) {
        expect(admitsNativeCapability({ ...policy, host }, request)).toBe(false);
      }
      const otherOnly: NativeCapabilityPolicy = {
        ...policy,
        admissions: policy.admissions.filter((entry) => entry.capability !== capability),
      };
      expect(admitsNativeCapability(otherOnly, request)).toBe(false);
    }
    expect(pinnedProviderRouteProtocol("codex")).toBe("codex-provider-returned.v1");
    expect(pinnedProviderRouteProtocol("claude")).toBe(undefined);
    expect(pinnedProviderRouteProtocol("injected")).toBe(undefined);
    expect(pinnedRouteProtocol("claude")).toBe("claude-client-native.v1");
    expect(pinnedRouteProtocol("codex")).toBe(undefined);
  });
});
