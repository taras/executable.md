import { until } from "effection";
import type { Scope } from "effection";
import type {
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  AcpxProviderDependencies,
  ProbeCapableRuntime,
} from "@executablemd/acp";

export function childRuntime(
  options: AcpRuntimeOptions,
  create: NonNullable<AcpxProviderDependencies["createRuntime"]>,
  scope: Scope,
  endpoint: (id: string) => string,
): ProbeCapableRuntime {
  const ordinary = create(options);
  let child: ProbeCapableRuntime | undefined;
  const handles = new WeakMap<AcpRuntimeHandle, ProbeCapableRuntime>();
  function selected(handle: AcpRuntimeHandle): ProbeCapableRuntime {
    const runtime = handles.get(handle);
    if (runtime === undefined) {
      throw new Error("This ACP handle was not issued by this runtime connection.");
    }
    return runtime;
  }
  return {
    ensureSession(input) {
      const runtime =
        input.agent === "xmd"
          ? (child ??= create({ ...options, elicitationModes: ["form"] }))
          : ordinary;
      const prepared =
        input.agent !== "xmd"
          ? input
          : {
              ...input,
              sessionOptions: {
                ...input.sessionOptions,
                env: {
                  ...input.sessionOptions?.env,
                  XMD_HEADLESS_SESSION: input.sessionKey,
                  XMD_HEADLESS_ENDPOINT: endpoint(input.sessionKey),
                },
              },
            };
      return runtime.ensureSession(prepared).then((handle) => {
        handles.set(handle, runtime);
        return handle;
      });
    },
    startTurn: (input) => selected(input.handle).startTurn(input),
    runTurn: (input) => selected(input.handle).runTurn(input),
    cancel: (input) => selected(input.handle).cancel(input),
    close: (input) => selected(input.handle).close(input),
    doctor: () => ordinary.doctor(),
    ...(ordinary.getStatus === undefined
      ? {}
      : {
          getStatus(input: Parameters<NonNullable<ProbeCapableRuntime["getStatus"]>>[0]) {
            const runtime = selected(input.handle);
            if (runtime.getStatus === undefined) {
              throw new Error("This ACP connection provides no status read.");
            }
            return runtime.getStatus(input);
          },
        }),
    ...(ordinary.getCapabilities === undefined
      ? {}
      : {
          getCapabilities(
            input: Parameters<NonNullable<ProbeCapableRuntime["getCapabilities"]>>[0],
          ) {
            const runtime = input.handle === undefined ? ordinary : selected(input.handle);
            if (runtime.getCapabilities === undefined) {
              throw new Error("This ACP connection provides no capabilities read.");
            }
            return runtime.getCapabilities(input);
          },
        }),
    ...(ordinary.setModel === undefined
      ? {}
      : {
          setModel(input: Parameters<NonNullable<ProbeCapableRuntime["setModel"]>>[0]) {
            const runtime = selected(input.handle);
            if (runtime.setModel === undefined) {
              throw new Error("This ACP connection provides no model control.");
            }
            return runtime.setModel(input);
          },
        }),
    ...(ordinary.setConfigOption === undefined
      ? {}
      : {
          setConfigOption(
            input: Parameters<NonNullable<ProbeCapableRuntime["setConfigOption"]>>[0],
          ) {
            const runtime = selected(input.handle);
            if (runtime.setConfigOption === undefined) {
              throw new Error("This ACP connection provides no configuration control.");
            }
            return runtime.setConfigOption(input);
          },
        }),
    ...(ordinary.setMode === undefined
      ? {}
      : {
          setMode(input: Parameters<NonNullable<ProbeCapableRuntime["setMode"]>>[0]) {
            const runtime = selected(input.handle);
            if (runtime.setMode === undefined) {
              throw new Error("This ACP connection provides no mode control.");
            }
            return runtime.setMode(input);
          },
        }),
    ...(ordinary.prepareFreshSession === undefined
      ? {}
      : {
          prepareFreshSession(
            input: Parameters<NonNullable<ProbeCapableRuntime["prepareFreshSession"]>>[0],
          ) {
            const runtime = selected(input.handle);
            if (runtime.prepareFreshSession === undefined) {
              throw new Error("This ACP connection provides no fresh-session operation.");
            }
            return runtime.prepareFreshSession(input);
          },
        }),
    shutdown: () =>
      scope.run(function* () {
        if (ordinary.shutdown !== undefined) {
          yield* until(ordinary.shutdown());
        }
        if (child?.shutdown !== undefined) {
          yield* until(child.shutdown());
        }
      }),
  };
}
