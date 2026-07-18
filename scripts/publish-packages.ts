/**
 * Build and publish every @executablemd workspace library to npm (primary) and
 * JSR (secondary), in dependency order.
 *
 * Usage:
 *   deno run -A scripts/publish-packages.ts <version>
 *
 * Publishable members and their order are derived from the manifests: any
 * workspace member with a deno.json name under @executablemd and a package.json
 * is published, dependencies before dependents. npm auth is expected to come
 * from OIDC (no token). JSR failures are non-fatal (secondary registry).
 */

import { exit, main, sleep } from "effection";
import { exec } from "@effectionx/process";
import { exists, fromFileUrl, readTextFile } from "@effectionx/fs";
import { z } from "npm:zod@^4";

const SCOPE = "@executablemd/";

const NamedSchema = z.object({ name: z.string() });
const DepsSchema = z.object({ dependencies: z.record(z.string(), z.string()).optional() });
const RootSchema = z.object({ workspace: z.array(z.string()) });

interface Member {
  dir: string;
  name: string;
  internal: string[];
}

await main(function* (args) {
  const version = args[0];
  if (!version) {
    console.error("usage: publish-packages.ts <version>");
    yield* exit(1);
    return;
  }

  const repoRoot = new URL("../", import.meta.url);
  const cwd = fromFileUrl(repoRoot);
  const root = RootSchema.parse(JSON.parse(yield* readTextFile(new URL("deno.json", repoRoot))));

  const members: Member[] = [];
  for (const dir of root.workspace) {
    const denoUrl = new URL(`${dir}/deno.json`, repoRoot);
    const pkgUrl = new URL(`${dir}/package.json`, repoRoot);
    if (!(yield* exists(denoUrl)) || !(yield* exists(pkgUrl))) {
      continue;
    }
    const named = NamedSchema.safeParse(JSON.parse(yield* readTextFile(denoUrl)));
    if (!named.success || !named.data.name.startsWith(SCOPE)) {
      continue;
    }
    const deps = DepsSchema.parse(JSON.parse(yield* readTextFile(pkgUrl))).dependencies ?? {};
    members.push({
      dir,
      name: named.data.name,
      internal: Object.keys(deps).filter((dep) => dep.startsWith(SCOPE)),
    });
  }

  // Topological order: a package's internal dependencies publish before it.
  const byName = new Map(members.map((member) => [member.name, member]));
  const ordered: Member[] = [];
  const seen = new Set<string>();
  const visit = (member: Member): void => {
    if (seen.has(member.name)) {
      return;
    }
    seen.add(member.name);
    for (const dep of member.internal) {
      const target = byName.get(dep);
      if (target) {
        visit(target);
      }
    }
    ordered.push(member);
  };
  for (const member of members) {
    visit(member);
  }

  console.log(`publishing @ ${version}: ${ordered.map((member) => member.name).join(", ")}`);

  // npm (primary): dnt build then publish, dependency order. Retry the build so
  // a just-published sibling has time to propagate before a dependent builds.
  for (const member of ordered) {
    let built = false;
    for (let attempt = 1; attempt <= 4 && !built; attempt++) {
      try {
        yield* exec("deno", {
          arguments: ["run", "-A", "scripts/build-npm.ts", member.dir, version],
          cwd,
        }).expect();
        built = true;
      } catch (error) {
        if (attempt === 4) {
          throw error;
        }
        console.log(`build ${member.name} failed (attempt ${attempt}); retrying in 15s`);
        yield* sleep(15_000);
      }
    }
    yield* exec("npm", {
      arguments: ["publish", "--access", "public"],
      cwd: fromFileUrl(new URL(`${member.dir}/npm/`, repoRoot)),
    }).expect();
    console.log(`npm: published ${member.name}@${version}`);
  }

  // JSR (secondary, best-effort): a failure must not fail the run.
  for (const member of ordered) {
    try {
      yield* exec("deno", {
        arguments: ["publish", "--allow-dirty"],
        cwd: fromFileUrl(new URL(`${member.dir}/`, repoRoot)),
      }).expect();
      console.log(`jsr: published ${member.name}`);
    } catch {
      console.log(`jsr: skipped ${member.name} (secondary registry)`);
    }
  }
});
