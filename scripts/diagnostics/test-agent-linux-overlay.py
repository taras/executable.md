from pathlib import Path

provider = Path("packages/acp/src/provider.ts")
test = Path("packages/test-agent/tests/session-configuration.test.ts")

def replace_once(path, old, new):
    source = path.read_text()
    if source.count(old) != 1:
        raise ValueError(f"{path}: unexpected source for {old!r}")
    path.write_text(source.replace(old, new))

replace_once(
    provider,
    "export function* useAcpxProvider(",
    "let timingRuntimeCount = 0;\n\nexport function* useAcpxProvider(",
)
replace_once(
    provider,
    """    const dir = yield* agentCwd();
    const options: AcpRuntimeOptions = {""",
    """    const dir = yield* agentCwd();
    const runtime = ++timingRuntimeCount;
    const launches = new Map<string, number>();
    const sessions = new Map<string, number>();
    const active = new Set<number>();
    const requests = new Map<number | string, string>();
    function trace(event: Record<string, string | number | null | number[]>) {
      console.log("XMD_TIMING " + JSON.stringify({ ms: performance.now(), runtime, ...event }));
    }
    const options: AcpRuntimeOptions = {""",
)
replace_once(
    provider,
    """      agentRegistry: registry,
      permissionMode: providerOptions.permissionMode,
      nonInteractivePermissions: "deny",
    };
    if (agentName !== undefined""",
    """      agentRegistry: registry,
      permissionMode: providerOptions.permissionMode,
      nonInteractivePermissions: "deny",
      processLifecycle: {
        onBeforeSpawn({ launchId, scope }) {
          const launch = launches.size + 1;
          launches.set(launchId, launch);
          if (scope.kind === "runtime-session" && !sessions.has(scope.sessionKey)) {
            sessions.set(scope.sessionKey, sessions.size + 1);
          }
          trace({ event: "before-spawn", launch, scope: scope.kind,
            session: scope.kind === "runtime-session" ? sessions.get(scope.sessionKey) ?? null : null });
        },
        onSpawned({ launchId, scope }) {
          const launch = launches.get(launchId);
          if (launch !== undefined) {
            if (scope.kind === "runtime-session") {
              active.add(launch);
            }
            trace({ event: "spawned", launch });
          }
        },
        onSpawnFailed({ launchId }) {
          trace({ event: "spawn-failed", launch: launches.get(launchId) ?? null });
        },
        onExit({ launchId, exitCode, signal }) {
          const launch = launches.get(launchId);
          if (launch !== undefined) {
            active.delete(launch);
            trace({ event: "exit", launch, exitCode, signal });
          }
        },
      },
      onAcpMessage(direction, message) {
        if (typeof message !== "object" || message === null ||
          !("id" in message) || (typeof message.id !== "string" && typeof message.id !== "number")) {
          return;
        }
        if (direction === "outbound" && "method" in message && typeof message.method === "string") {
          requests.set(message.id, message.method);
          trace({ event: "request", method: message.method, launches: [...active] });
        } else if (direction === "inbound" && !("method" in message)) {
          const method = requests.get(message.id);
          if (method !== undefined) {
            requests.delete(message.id);
            trace({ event: "response", method, launches: [...active] });
          }
        }
      },
    };
    if (agentName !== undefined""",
)
replace_once(
    test,
    """    const origin = performance.now();
    yield* NativeSessionObserver.set((report) =>
      sessions.push({ ...report, elapsedMs: performance.now() - origin }),
    );""",
    """    const origin = performance.now();
    const scenarios = new Map<string, number>();
    console.log("XMD_TIMING " + JSON.stringify({
      event: "run-start", ms: origin, fixture: path.basename(doc),
    }));
    yield* NativeSessionObserver.set((report) => {
      if (!scenarios.has(report.scenarioId)) {
        scenarios.set(report.scenarioId, scenarios.size + 1);
      }
      const ms = performance.now();
      sessions.push({ ...report, elapsedMs: ms - origin });
      console.log("XMD_TIMING " + JSON.stringify({
        event: "receipt", ms, scenario: scenarios.get(report.scenarioId),
      }));
    });""",
)
replace_once(
    test,
    """    const results = yield* testing.results;
    return { result, output: next.value, results, sessions };""",
    """    const results = yield* testing.results;
    console.log("XMD_TIMING " + JSON.stringify({
      event: "run-result", ms: performance.now(), fixture: path.basename(doc),
      results: results.map(({ name, status, error }) => ({ name, status, error: error?.kind })),
    }));
    return { result, output: next.value, results, sessions };""",
)
