import type { Operation } from "effection";
import { fileSha256 } from "../digest.ts";
import { hostBinary, WORKERD_VERSION } from "../manifest.ts";

export interface Materialized {
  workerdPath: string;
  configPath: string;
  backendsConfigPath: string;
}

const embedded = {
  workerd: new URL("../vendor/workerd", import.meta.url),
  worker: new URL("../dist/worker.js", import.meta.url),
  config: new URL("./config.capnp", import.meta.url),
  backendsConfig: new URL("./config-backends.capnp", import.meta.url),
};

// The compiled proof executable carries workerd, the Worker bundle, and the
// capnp config in its embedded filesystem; launching means materializing them
// into a version-addressed cache directory and validating the binary digest.
export function* materialize(): Operation<Materialized> {
  const binary = hostBinary();
  const cacheHome = Deno.env.get("XDG_CACHE_HOME") ??
    `${Deno.env.get("HOME")}/.cache`;
  const root = `${cacheHome}/xmd-spike-347/${WORKERD_VERSION}`;
  Deno.mkdirSync(root, { recursive: true });

  const workerdPath = `${root}/workerd`;
  if (!(yield* matchesDigest(workerdPath, binary.sha256))) {
    Deno.writeFileSync(workerdPath, Deno.readFileSync(embedded.workerd), {
      mode: 0o755,
    });
    const digest = yield* fileSha256(workerdPath);
    if (digest !== binary.sha256) {
      Deno.removeSync(workerdPath);
      throw new Error(
        `materialized workerd digest mismatch: expected ${binary.sha256}, wrote ${digest}`,
      );
    }
  }

  const configPath = `${root}/config.capnp`;
  const backendsConfigPath = `${root}/config-backends.capnp`;
  Deno.writeFileSync(`${root}/worker.js`, Deno.readFileSync(embedded.worker));
  Deno.writeFileSync(configPath, Deno.readFileSync(embedded.config));
  Deno.writeFileSync(
    backendsConfigPath,
    Deno.readFileSync(embedded.backendsConfig),
  );

  return { workerdPath, configPath, backendsConfigPath };
}

function* matchesDigest(path: string, expected: string): Operation<boolean> {
  try {
    Deno.statSync(path);
  } catch {
    return false;
  }
  const digest = yield* fileSha256(path);
  return digest === expected;
}
