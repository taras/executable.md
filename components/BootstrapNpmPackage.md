---
title: Bootstrap an npm package
required: [package]
props:
  package:
    type: string
    pattern: "^packages/[a-z0-9][a-z0-9._-]*$"
    description: Workspace package directory, e.g. packages/workflow
---

> [!WARNING]
> Run this **without `-j`/`--journal` and without `--verbose`**. A durable entry
> records the one-time password twice over: once as the answer you gave, and
> again inside the publish and trust commands it is interpolated into.
> `--verbose` reports the same records to stderr. Rendered output carries only
> what a command printed, so the code stays out of the document — but a journal
> file or a verbose stderr stream would hold it. Neither is needed here.
>
> `README.md#Bootstrap` is the target this is normally run from, and
> `specs/release-process-spec.md` §6 carries the whole procedure.

# Bootstrapping {props.package}

Before the CI workflow can publish packages to npm, the package needs to be
published manually once.

CI authenticates with OIDC: GitHub Actions mints a short-lived identity token
for the workflow run, and npm accepts it because the package lists this
repository as a trusted publisher. Nothing is stored as a secret anywhere. The
catch is that npm only lets you configure a trusted publisher on a package that
already exists — so the first version can't come from CI.

Publishing by hand uses the other route: your npm login plus a one-time password
(OTP), the six-digit code from your authenticator app. This document asks for
that code when it needs it, publishes an empty placeholder version to create the
record, then configures the trust that lets CI take over.

The placeholder goes out under a dist-tag called `bootstrap`. A dist-tag is a
named pointer to one version, and `latest` is the one npm installs when you
don't ask for anything specific — so publishing under `bootstrap` means the
placeholder exists without anyone installing it by accident. The real package
ships as `latest` with the first tagged release.

## Checking what this needs

`npm trust` is the command that registers a trusted publisher: it tells npm
which GitHub Actions workflow is allowed to publish this package, which is what
CI authenticates against later. It arrived in npm 11.15.

Publishing by hand needs you logged in, so that's checked too. An old npm can
reserve the name and then fail to configure the trust, leaving the package half
done — better to find out now.

<Capture as="npmWhoami">

```bash exec
npm whoami --registry=https://registry.npmjs.org
```

</Capture>

<Capture as="npmVersionOutput">

```bash exec
npm --version
```

</Capture>

<Capture as="manifestSchema" select="code[lang=json]">

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "pattern": "^@executablemd/[a-z0-9][a-z0-9._-]*$"
    },
    "description": { "type": "string" }
  },
  "required": ["name"]
}
```

</Capture>

```ts eval
const registry = "https://registry.npmjs.org";
const bootstrapVersion = "0.0.0-bootstrap.0";
const repository = "taras/executable.md";
const workflowFile = "publish-packages.yml";
const environment = "npm-publish";
const expectedTrust = { repository, workflowFile, environment };

const npmUser = npmWhoami.trim();
const npmVersion = npmVersionOutput.trim();
const [npmMajor, npmMinor] = npmVersion.split(".").map(Number);
if (!(npmMajor > 11 || (npmMajor === 11 && npmMinor >= 15))) {
  throw new Error(
    `npm trust needs npm 11.15 or newer, and this is npm ${npmVersion}. Install a newer npm and run this again.`,
  );
}

const packageManifestPath = `${props.package}/package.json`;
const denoManifestPath = `${props.package}/deno.json`;
```

  Logged in as {npmUser}
  npm {npmVersion}

As a sanity check, let's confirm the npm package name and the JSR package name
match. Every package here is published to both: npm from `package.json`, and
JSR — the Deno registry — from `deno.json`.

<Parse schema={manifestSchema} as="packageManifest">
<File path={packageManifestPath} />
</Parse>

<Parse schema={manifestSchema} as="denoManifest">
<File path={denoManifestPath} />
</Parse>

```ts eval
const packageName = packageManifest.name;
if (denoManifest.name !== packageName) {
  throw new Error(
    `${props.package} is published to npm as ${packageName} and to JSR as ${denoManifest.name}. The two names must match before it can be bootstrapped.`,
  );
}
```

  package.json   {packageName}  ✓
  deno.json      {denoManifest.name}  ✓

## Looking at the registry

Asking first is what makes this safe to run twice. The placeholder and the
trusted publisher are skipped separately when they are already there, so a run
interrupted partway finishes what is missing instead of starting over.

The same answers stop you from bootstrapping a package that has already been set
up. Real versions published, or a `bootstrap` tag pointing at something else,
mean this is a live package — and treating a live package as a fresh one could
break it for everyone installing it. Either stops the run here, before you are
asked for a code and before anything is written.

What the package already trusts is the third answer, and it is read further
down, after the code. npm makes the trusted publisher readable only to someone
who could change it, so `npm trust list` needs a one-time password even to
answer. That refusal comes later than these two, but it still comes before
anything is written.

npm answers a question about a package it does not carry by exiting non-zero, so
these reads are written `exec as="…"`: the block binds what the command settled
to — its exit code and its two channels, kept apart — instead of printing it,
and a non-zero exit raises nothing. Here a 404 is an answer rather than a
failure, and the comparison below is what decides which.

```ts eval
/**
 * npm's own diagnostics are what these detail lines carry, and they run to
 * several lines. Indenting every one of them keeps a report readable as the
 * block it is.
 */
function indent(text) {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}

function permissionLabel(permission) {
  if (permission === "createPackage") {
    return "publish";
  }
  if (permission === "createStagedPackage") {
    return "stage publish";
  }
  return permission;
}

function classifyReservation(versionsResult, distTagsResult, version) {
  if (versionsResult.exitCode !== 0) {
    if (/E404|404 Not Found/.test(versionsResult.stderr)) {
      return { state: "absent", detail: "" };
    }
    return { state: "unreadable", detail: `npm could not report versions: ${versionsResult.stderr.trim()}` };
  }
  const text = versionsResult.stdout.trim();
  let published = null;
  try {
    published = JSON.parse(text);
  } catch (error) {
    published = null;
  }
  const versions = typeof published === "string" ? [published] : published;
  if (!Array.isArray(versions) || versions.some((each) => typeof each !== "string")) {
    return { state: "unreadable", detail: `npm did not report readable versions: ${text}` };
  }
  if (versions.length !== 1 || versions[0] !== version) {
    return {
      state: "conflicting",
      detail: `it has ${versions.length} published version(s): ${versions.join(", ")}`,
    };
  }
  if (distTagsResult.exitCode !== 0) {
    return {
      state: "unreadable",
      detail: `npm could not report dist-tags: ${distTagsResult.stderr.trim()}`,
    };
  }
  const tagText = distTagsResult.stdout.trim();
  let tags = null;
  try {
    tags = JSON.parse(tagText);
  } catch (error) {
    tags = null;
  }
  if (tags === null || typeof tags !== "object" || Array.isArray(tags)) {
    return { state: "unreadable", detail: `npm did not report readable dist-tags: ${tagText}` };
  }
  const entries = Object.entries(tags);
  const named = entries.map(([tag, at]) => `${tag} → ${at}`).join(", ");
  if (entries.length !== 1 || entries[0][0] !== "bootstrap" || entries[0][1] !== version) {
    return { state: "conflicting", detail: `its dist-tags are ${named}` };
  }
  return { state: "reserved", detail: "" };
}

function classifyTrust(trustResult, expected, packageIsAbsent) {
  if (trustResult.exitCode !== 0) {
    if (packageIsAbsent && /E404|404 Not Found/.test(trustResult.stderr)) {
      return { state: "absent", detail: "", id: "", summary: "" };
    }
    return {
      state: "unreadable",
      detail: `npm could not report the trusted publisher: ${trustResult.stderr.trim()}`,
      id: "",
      summary: "",
    };
  }
  const text = trustResult.stdout.trim();
  if (text === "") {
    return { state: "absent", detail: "", id: "", summary: "" };
  }
  let config = null;
  try {
    config = JSON.parse(text);
  } catch (error) {
    config = null;
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return {
      state: "unreadable",
      detail: `npm did not report a readable trusted publisher: ${text}`,
      id: "",
      summary: "",
    };
  }
  const permissions = Array.isArray(config.permissions) ? config.permissions : [];
  const summary = [
    config.repository ?? "no repository",
    config.file ?? "no workflow",
    config.environment ?? "no environment",
    permissions.map(permissionLabel).join(", ") || "no permissions",
  ].join(" · ");
  const matches = config.type === "github" &&
    config.repository === expected.repository &&
    config.file === expected.workflowFile &&
    config.environment === expected.environment &&
    permissions.length === 1 &&
    permissions[0] === "createPackage";
  return {
    state: matches ? "expected" : "conflicting",
    detail: summary,
    id: typeof config.id === "string" ? config.id : "",
    summary,
  };
}
```

```bash exec as="versions"
npm view {packageName} versions --json --registry {registry}
```

```bash exec as="distTags"
npm view {packageName} dist-tags --json --registry {registry}
```

```ts eval
const reservation = classifyReservation(versions, distTags, bootstrapVersion);
const reservationDetail = indent(reservation.detail);
```

<If condition={reservation.state === "conflicting"}>

`{packageName}` is already a live package on npm — {reservation.detail}.

Nothing has been published and no code was requested. If you meant a different
package, check the directory you passed.

```ts eval
throw new Error(`${packageName} is already published; refusing to bootstrap it`);
```

</If>

<If condition={reservation.state === "unreadable"}>

npm did not answer what `{packageName}` has published:

{reservationDetail}

Nothing has been published and no code was requested. This is npm failing to
answer rather than an answer this document refuses, so running it again once npm
responds starts from the same place.

```ts eval
throw new Error(`${packageName}: ${reservation.detail}`);
```

</If>

<If condition={reservation.state === "reserved"}>

  {packageName} is already reserved at {bootstrapVersion} — the publish will be skipped

</If>

<If condition={reservation.state === "absent"}>

  {packageName} is not on npm — it will be reserved at {bootstrapVersion}

</If>

<TempDir>

<If condition={reservation.state === "absent"}>

## Previewing the artifact

The placeholder declares no dependencies at all, and that is deliberate: a
package that depends on its siblings cannot be built until those siblings are on
npm, and they cannot be published until this record exists. An empty artifact
has no such circle to break.

`npm pack` builds the tarball npm would upload, and `--dry-run` stops it from
uploading — so this is a look at the exact files that will be published, from
the exact directory they will be published from.

```ts eval
const artifactManifest = `${
  JSON.stringify(
    {
      name: packageName,
      version: bootstrapVersion,
      description: `Placeholder reserving the ${packageName} package name.`,
      license: "MIT",
      repository: {
        type: "git",
        url: `git+https://github.com/${repository}.git`,
      },
      homepage: "https://executable.md",
      files: ["README.md"],
    },
    null,
    2,
  )
}\n`;
const artifactDisplay = artifactManifest.trimEnd().split("\n").map((line) => `  ${line}`).join("\n");
```

<File path="package.json">{artifactManifest}</File>

<File path="README.md">
# {packageName}

This is a placeholder reserving the package name. It contains no implementation.
Install a stable release from the `latest` dist-tag once one exists.
</File>

<Capture as="packOutput">

```bash exec
npm pack --dry-run --json
```

</Capture>

```ts eval
const packDisplay = (() => {
  let packed = null;
  try {
    packed = JSON.parse(packOutput.trim());
  } catch (error) {
    packed = null;
  }
  const entry = Array.isArray(packed) ? packed[0] : packed;
  const files = entry && Array.isArray(entry.files) ? entry.files : [];
  if (files.length === 0) {
    return "  npm reported no files";
  }
  const width = Math.max(...files.map((file) => String(file.path).length));
  const listed = files
    .map((file) => `  ${String(file.path).padEnd(width)}   ${file.size} B`)
    .join("\n");
  return `${listed}\n  ${files.length} files, ${entry.unpackedSize} B unpacked`;
})();
```

  {packageName}@{bootstrapVersion}

{artifactDisplay}

{packDisplay}

</If>

## Authenticating

Everything up to now has only read, and nothing below it has written yet. The
code comes here because the last question this document asks the registry needs
it as much as the two writes do: npm answers `npm trust list` only to someone
who could change what it reports.

Enter a fresh code. Codes expire after about thirty seconds, so one generated a
minute ago may not survive the steps below. A code that expires partway leaves
whatever landed before it in place, and running the document again finishes the
rest.

<Capture as="otpSchema" select="code[lang=json]">

```json
{
  "type": "object",
  "properties": {
    "code": {
      "type": "string",
      "pattern": "^\\d{6}$"
    }
  },
  "required": ["code"],
  "additionalProperties": false
}
```

</Capture>

<Elicit schema={otpSchema} as="otp">
Enter a fresh six-digit npm one-time password. It authorizes reading what the
package already trusts, the placeholder publish, and the trusted-publisher
configuration, so generate it now rather than reusing one from a moment ago.
</Elicit>

## Reading the trusted publisher

This is the answer the reads above could not get. npm holds one trusted
publisher per package and refuses a second, so a configuration that is not the
one in this document's table means the package has been set up by someone else —
and that stops the run here, before the placeholder is published. A refusal
leaves npm exactly as it was.

```bash exec as="trustList"
npm_config_otp={otp.code} npm trust list {packageName} --json --registry {registry}
```

```ts eval
const trust = classifyTrust(
  trustList,
  expectedTrust,
  reservation.state === "absent",
);
const trustDetail = indent(trust.detail);
```

<If condition={trust.state === "conflicting"}>

`{packageName}` already trusts a publisher this document did not set up:

  {trust.summary}

Nothing was published and nothing was changed. npm refuses a second
configuration, so replacing this one means revoking it deliberately first:

  npm trust revoke {packageName} --id {trust.id}

```ts eval
throw new Error(`${packageName} already has a trusted publisher; refusing to replace it`);
```

</If>

<If condition={trust.state === "unreadable"}>

npm did not answer what `{packageName}` trusts:

{trustDetail}

Nothing was published and nothing was changed. An expired code reads this way
too, so if that is what happened, generate a fresh one and run this again.

```ts eval
throw new Error(`${packageName}: ${trust.detail}`);
```

</If>

<If condition={trust.state === "expected"}>

  Its trusted publisher already matches — it will be left alone

</If>

<If condition={trust.state === "absent"}>

  It has no trusted publisher — one will be created for {repository}

</If>

<If condition={reservation.state === "absent"}>

## Reserving the name

The registry is read once more rather than trusting what it said before the
prompt. You have been away with your authenticator, and the package may have
gained a version in the meantime.

```bash exec as="versionsAfter"
npm view {packageName} versions --json --registry {registry}
```

```bash exec as="distTagsAfter"
npm view {packageName} dist-tags --json --registry {registry}
```

```ts eval
const reservationNow = classifyReservation(
  versionsAfter,
  distTagsAfter,
  bootstrapVersion,
);
```

<If condition={reservationNow.state === "conflicting" || reservationNow.state === "unreadable"}>

`{packageName}` changed while you were entering your code — {reservationNow.detail}.

Nothing has been published.

```ts eval
throw new Error(`${packageName} changed during the prompt; refusing to publish over it`);
```

</If>

<If condition={reservationNow.state === "reserved"}>

  Someone else reserved {packageName}@{bootstrapVersion} while you were answering — skipping the publish

</If>

<If condition={reservationNow.state === "absent"}>

The write is bound the way the reads are. `exec as="…"` keeps a successful
publish quiet without discarding what npm said, so a refusal is reported in
npm's own words rather than as an exit code with the reason thrown away.

```bash exec as="publishResult"
npm_config_otp={otp.code} npm publish --access public --tag bootstrap --registry {registry}
```

```ts eval
const publishDetail = indent(
  publishResult.stderr.trim() || publishResult.stdout.trim(),
);
```

<If condition={publishResult.exitCode !== 0}>

npm refused to publish `{packageName}@{bootstrapVersion}`:

{publishDetail}

An expired code reads this way, and so does a version npm already carries — its
package reads can lag a publish by minutes, so a reservation this document
reported as missing may have been made moments ago. Nothing was configured.

```ts eval
throw new Error(`${packageName}@${bootstrapVersion} was not published: ${publishResult.stderr.trim()}`);
```

</If>

  Reserved {packageName}@{bootstrapVersion} under the bootstrap dist-tag

</If>

</If>

## Granting this repository publish rights

The read above already happened after your code, and the only write since was
the placeholder, so it still describes what npm holds — there is no away-time to
re-read for. If a publisher is configured in the seconds between, npm refuses
the second one and the command below fails: the placeholder stands, and running
the document again reports what it found.

<If condition={trust.state === "expected"}>

  {packageName} already trusts this repository — leaving it alone

</If>

<If condition={trust.state === "absent"}>

```bash exec as="trustResult"
npm_config_otp={otp.code} npm trust github {packageName} --file {workflowFile} --repository {repository} --environment {environment} --allow-publish --registry {registry} --yes
```

```ts eval
const trustResultDetail = indent(
  trustResult.stderr.trim() || trustResult.stdout.trim(),
);
```

<If condition={trustResult.exitCode !== 0}>

npm refused to trust {repository} with `{packageName}`:

{trustResultDetail}

A publisher configured in the seconds since the read above reads this way, and
so does an expired code. The placeholder stands, so running the document again
picks up the half that is missing.

```ts eval
throw new Error(`${packageName} did not gain a trusted publisher: ${trustResult.stderr.trim()}`);
```

</If>

  Trusted {repository} via {workflowFile} in {environment}, publish only

</If>

## Confirming

Read back from npm after the writes, so what follows is what the registry says
rather than what this document did.

npm accepts a publish before its package reads report it: a name it has just
started carrying answers 404 for a while, and that is the same answer it gives
for a name it does not carry at all. Reading straight away would fail a run that
worked, so the reads wait for the registry to carry the package first. `when`
asks until it does, for up to a minute — a package that was already there is
answered on the first ask and waits for nothing.

```ts eval
yield* when(function* () {
  const readiness = yield* fetch(`${registry}/${packageName}`, { method: "HEAD" });
  if (!readiness.ok) {
    throw new Error(
      `npm still answers ${readiness.status} for ${packageName}, a minute after the writes this run made were accepted`,
    );
  }
}, { timeout: 60_000, interval: 2_000 });
```

```bash exec as="finalVersions"
npm view {packageName} versions --json --registry {registry}
```

```bash exec as="finalDistTags"
npm view {packageName} dist-tags --json --registry {registry}
```

```bash exec as="finalTrustList"
npm_config_otp={otp.code} npm trust list {packageName} --json --registry {registry}
```

```ts eval
const finalReservation = classifyReservation(
  finalVersions,
  finalDistTags,
  bootstrapVersion,
);
const finalTrust = classifyTrust(finalTrustList, expectedTrust, false);
```

<If condition={finalReservation.state === "absent"}>

npm carries `{packageName}` — the wait above ended because the registry said so
— but its package reads still report nothing published. The two answers come
from the same registry at different speeds, and this is the slower one not
having caught up yet.

Nothing here failed and nothing is half done. Run this document again to read
the end state once npm agrees with itself.

```ts eval
throw new Error(
  `${packageName}: npm's package reads have not caught up with what it carries`,
);
```

</If>

```ts eval
if (finalReservation.state !== "reserved") {
  throw new Error(
    `${packageName} is not reserved at ${bootstrapVersion} under the bootstrap dist-tag: ${
      finalReservation.detail || finalReservation.state
    }`,
  );
}
if (finalTrust.state !== "expected") {
  throw new Error(
    `${packageName} does not carry the expected trusted publisher: ${
      finalTrust.detail || finalTrust.state
    }`,
  );
}
```

  {bootstrapVersion} is the only published version
  bootstrap → {bootstrapVersion} is the only dist-tag
  {finalTrust.summary}

If you ever need to undo the trust configuration — the workflow moves, the
environment is renamed, the package changes hands — revoke it by id and run this
document again:

  npm trust revoke {packageName} --id {finalTrust.id}

</TempDir>

## Afterwards

Create the matching package on JSR under the `@executablemd` scope and link it
to this repository before the next tagged release. `deno publish` publishes the
whole workspace as a unit and fails for a package that does not exist on JSR, so
one uncreated package fails the release for every package.
