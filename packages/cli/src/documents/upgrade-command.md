---
props:
  type: object
  properties:
    requestedTag: { type: [string, "null"] }
    status: { type: boolean }
    allowDowngrade: { type: boolean }
    allowPrerelease: { type: boolean }
    installation:
      type: object
      properties:
        provenance:
          type: string
          enum: [compiled, compiled-windows, deno-source, npm-node, bun-source]
        currentVersion: { type: string }
        executablePath: { type: string }
        platform: { type: string }
        architecture: { type: string }
        target: { type: [string, "null"] }
      required:
        [provenance, currentVersion, executablePath, platform, architecture, target]
      additionalProperties: false
  required: [requestedTag, status, allowDowngrade, allowPrerelease, installation]
  additionalProperties: false
---

# Upgrade XMD

<If condition={props.installation.provenance === "compiled-windows"}>
<Fail message="The Windows xmd binary cannot replace itself while it is running. Run the standalone installer again or download xmd-x86_64-pc-windows-msvc.exe from the Releases page. No release was read, and the binary was not changed." />
</If>

<If condition={props.installation.provenance === "npm-node"}>
<Fail message="npm manages this xmd installation. Run npm install -g @executablemd/cli@latest, or replace latest with an exact package version. No release was read, and the binary was not changed." />
</If>

<If condition={props.installation.provenance === "bun-source"}>
<Fail message="Bun manages this xmd installation. Run bun add -g @executablemd/cli@latest, or replace latest with an exact package version. No release was read, and the binary was not changed." />
</If>

<If condition={props.installation.provenance === "deno-source"}>
<Fail message="This xmd is running through Deno or a repository checkout. Update the jsr:@executablemd/cli version, or update the checkout and run deno task setup. No release was read, and no binary was changed." />
</If>

<If condition={props.installation.target === null}>
<Fail
  message={`No xmd release is published for ${props.installation.platform}/${props.installation.architecture}. Build xmd from a checkout for this platform, or use a supported platform listed at https://github.com/taras/executable.md/releases. No release was read, and the binary was not changed.`}
/>
</If>

```ts eval
import { compare as compareSemVer, parse as parseSemVer } from "semver";

function parseTag(tag) {
  if (!tag.startsWith("v") || tag.includes("+")) {
    return null;
  }

  const source = tag.slice(1);
  const parsed = parseSemVer(source, { loose: false });
  if (parsed === null || parsed.version !== source) {
    return null;
  }

  return {
    tag,
    version: parsed.version,
    prerelease: parsed.prerelease.length > 0,
  };
}

function comparePrereleaseIdentifiers(left, right) {
  const identifiers = (version) =>
    version.includes("-") ? version.slice(version.indexOf("-") + 1).split(".") : [];
  const leftParts = identifiers(left);
  const rightParts = identifiers(right);

  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const a = leftParts[index];
    const b = rightParts[index];
    if (a === undefined) {
      return leftParts.length === 0 ? 1 : -1;
    }
    if (b === undefined) {
      return rightParts.length === 0 ? -1 : 1;
    }
    if (a === b) {
      continue;
    }
    const numericA = /^[0-9]+$/.test(a);
    const numericB = /^[0-9]+$/.test(b);
    if (numericA && numericB) {
      return BigInt(a) < BigInt(b) ? -1 : 1;
    }
    if (numericA !== numericB) {
      return numericA ? -1 : 1;
    }
    return a < b ? -1 : 1;
  }
  return 0;
}

function compareVersions(left, right) {
  const ordering = compareSemVer(left.version, right.version);
  if (ordering !== 0 || left.version === right.version) {
    return ordering;
  }
  return comparePrereleaseIdentifiers(left.version, right.version);
}

const requestedVersion =
  props.requestedTag === null ? null : parseTag(props.requestedTag);
const currentVersion = parseTag(`v${props.installation.currentVersion}`);
const invalidTag = props.requestedTag !== null && requestedVersion === null;
const requestedPrerelease = requestedVersion?.prerelease === true;

function refuseOptions() {
  if (invalidTag) {
    return (
      `${props.requestedTag} is not a valid release tag format. Specify vX.Y.Z for a stable release or ` +
      "vX.Y.Z-<prerelease> for a prerelease. The + suffix is not supported. No release was read, and the binary was not changed."
    );
  }
  if (props.status && (props.allowDowngrade || props.allowPrerelease)) {
    return (
      "--status does not install a release, so it cannot be used with --allow-downgrade or " +
      "--allow-prerelease. Remove any consent options and run the command again. No release was read, and the binary was not changed."
    );
  }
  if (props.allowPrerelease && !requestedPrerelease) {
    return "--allow-prerelease requires a valid prerelease tag. Specify that tag or remove the option. No release was read, and the binary was not changed.";
  }
  if (currentVersion === null) {
    return (
      `The installed binary reports version ${props.installation.currentVersion}, which is not a valid release version.\n` +
      "Reinstall xmd with:\n" +
      "curl -fsSL https://executable.md/install.sh | sh\n" +
      "No release was read, and the binary was not changed."
    );
  }
  return null;
}

const optionRefusal = refuseOptions();
```

<If condition={optionRefusal !== null}>
<Fail message={optionRefusal} />
</If>

<If condition={props.status}>
Compares the installed XMD version with the selected release without downloading
a binary or changing the installation.
</If>

<If condition={!props.status && props.requestedTag === null}>
Installs the latest published stable version of XMD. Verifies the release before
replacing the standalone binary that ran this command.
</If>

<If condition={!props.status && props.requestedTag !== null}>
Installs XMD release {props.requestedTag}. Verifies the release before replacing
the standalone binary that ran this command.
</If>

<If condition={props.status}>
## Select a release

Reads release information from `taras/executable.md`. Ignores drafts and
releases with invalid tags.
<Else>
## Select a release

Checks that the installed XMD binary can be replaced atomically and takes its
installation lock without waiting. Reads release information from
`taras/executable.md`. Ignores drafts and releases with invalid tags.
</Else>
</If>

<Upgrade.Releases requestedTag={props.requestedTag} as="releaseRead" />

```ts eval
const releaseReadFailures = {
  "busy":
    `Another xmd upgrade is already running.\nBinary: ${props.installation.executablePath}\nLet it finish, then run this command again. No release was read, no binary was downloaded or staged, and the installation was not changed.`,
  "symbolic-link":
    `This xmd binary is a symbolic link.\nBinary: ${props.installation.executablePath}\nReinstall xmd as a regular file with:\ncurl -fsSL https://executable.md/install.sh | sh\nNo release was read, and the binary was not changed.`,
  "unwritable-parent":
    `The directory containing this xmd binary is not writable.\nBinary: ${props.installation.executablePath}\nMove the binary to a writable directory, or reinstall xmd with:\ncurl -fsSL https://executable.md/install.sh | sh\nThis command did not run sudo. No release was read, and the binary was not changed.`,
  "unsupported-filesystem":
    `The filesystem containing this xmd binary does not support atomic replacement.\nBinary: ${props.installation.executablePath}\nMove or reinstall xmd on a local filesystem, then run this command again. No release was read, and the binary was not changed.`,
};
const releaseReadFailure = releaseRead.ok
  ? null
  : releaseReadFailures[releaseRead.error.code] ??
    "The command could not read or validate GitHub release information. Check your network connection and https://github.com/taras/executable.md/releases, then run this command again. No binary was downloaded, and the installation was not changed.";
```

<If condition={releaseReadFailure !== null}>
<Fail message={releaseReadFailure} />
</If>

```ts eval
const published = releaseRead.value.releases.filter((release) => !release.draft);
const selected = props.requestedTag === null
  ? published.find((release) => !release.prerelease && parseTag(release.tag)?.prerelease === false)
  : published.find((release) => release.tag === props.requestedTag);
const selectionFailure = selected === undefined
  ? props.requestedTag === null
    ? "GitHub has no published stable xmd release. Try again after one is published. No binary was downloaded, and the installation was not changed."
    : `GitHub has no published xmd release tagged ${props.requestedTag}. Choose a published tag from https://github.com/taras/executable.md/releases, then run this command again. No binary was downloaded, and the installation was not changed.`
  : parseTag(selected.tag) === null
    ? "The selected GitHub release has an invalid tag format. Choose another published release, or report it at https://github.com/taras/executable.md/issues. No binary was downloaded, and the installation was not changed."
    : null;
```

<If condition={selectionFailure !== null}>
<Fail message={selectionFailure} />
</If>

```ts eval
const selectedVersion = parseTag(selected.tag);
const ordering = compareVersions(selectedVersion, currentVersion);
const comparison = ordering > 0 ? "newer" : ordering < 0 ? "older" : "current";

function refuseConsent() {
  if (props.allowDowngrade && comparison !== "older") {
    return `--allow-downgrade applies only to an older release. ${selected.tag} is ${comparison} compared with installed version ${props.installation.currentVersion}. Remove the option and run this command again. No binary was downloaded, and the installation was not changed.`;
  }
  if (
    !props.status &&
    comparison !== "current" &&
    requestedPrerelease &&
    !props.allowPrerelease
  ) {
    return `${selected.tag} is a prerelease.\nTo install it, run:\nxmd upgrade ${selected.tag} --allow-prerelease${
      comparison === "older" ? " --allow-downgrade" : ""
    }\nNo binary was downloaded, and the installation was not changed.`;
  }
  if (!props.status && comparison === "older" && !props.allowDowngrade) {
    return `${selected.tag} is older than installed version ${props.installation.currentVersion}.\nTo install it, run:\nxmd upgrade ${selected.tag} --allow-downgrade${
      requestedPrerelease ? " --allow-prerelease" : ""
    }\nNo binary was downloaded, and the installation was not changed.`;
  }
  return null;
}

const consentRefusal = refuseConsent();

// Named once so each installation phase below can be its own top-level
// segment. Nesting them inside a single `<If>` makes the whole branch one
// segment, and its content reaches the reader only when the branch ends —
// which would turn the transcript back into a report written after the fact.
const authorized = !props.status && comparison !== "current";
```

<If condition={consentRefusal !== null}>
<Fail message={consentRefusal} />
</If>

<If condition={props.status}>
## Release status

The installed and selected versions were compared using semantic version
precedence.

Installed version: {props.installation.currentVersion}
Selected release: {selected.tag} ({comparison})
Release notes: {selected.url}
No files were changed.
</If>

<If condition={!props.status && comparison === "current"}>
## Installing existing version

The selected release was compared with the installed version. They are the same,
so no download or replacement was needed.

xmd {props.installation.currentVersion} is already installed.
Binary: {props.installation.executablePath}
Release notes: {selected.url}
No download or replacement was needed.
</If>

<If condition={authorized}>
## Install selected release

The selected release passed the comparison and consent checks.

Selected release: {selected.tag} ({comparison} than installed version {props.installation.currentVersion})
</If>

<If condition={authorized}>
Downloads the checksum file and target binary from the selected GitHub release.
Stages the binary beside the installed one without making it executable.

<Upgrade.Download release={selected.identity} as="downloadResult" />

```ts eval
function installationFailure(code) {
  const failures = {
    "asset-missing":
      `Release ${selected.tag} does not include a binary for ${props.installation.target}. The installed binary was not changed. Choose another published release, or report it at https://github.com/taras/executable.md/issues.`,
    "checksums-missing":
      `Release ${selected.tag} does not include checksums.txt, so its binary cannot be verified. The installed binary was not changed. Choose another published release, or report it at https://github.com/taras/executable.md/issues.`,
    "checksum-entry-missing":
      `checksums.txt for release ${selected.tag} does not include the ${props.installation.target} binary, so it cannot be verified. The installed binary was not changed. Choose another published release, or report it at https://github.com/taras/executable.md/issues.`,
    "checksum-entry-duplicate":
      `checksums.txt for release ${selected.tag} includes the ${props.installation.target} binary more than once, so it cannot be verified reliably. The installed binary was not changed. Report the release at https://github.com/taras/executable.md/issues. Do not install it manually.`,
    "checksum-mismatch":
      `The downloaded ${selected.tag} binary does not match its published SHA-256 checksum. The installed binary was not changed, and the downloaded binary was not run. Try again, or report the release at https://github.com/taras/executable.md/issues.`,
    "candidate-version-mismatch":
      `The checksum-verified ${selected.tag} binary did not report version ${selected.tag.slice(1)}. The installed binary was not changed. Report the release at https://github.com/taras/executable.md/issues. Do not install the downloaded binary manually.`,
    "redirect-refused":
      `A download for release ${selected.tag} redirected outside GitHub’s release download service. The installed binary was not changed. Check ${selected.url}, then try again or report it at https://github.com/taras/executable.md/issues.`,
    "download-failed":
      `The command could not completely download the ${selected.tag} binary or checksums.txt. The installed binary was not changed. Check your network connection, then run this command again.`,
    "replacement-failed":
      `The command could not prepare or atomically replace the installed binary with release ${selected.tag}.\nBinary: ${props.installation.executablePath}\nThe installed binary was not changed. Check available disk space, directory permissions, and filesystem support, then run this command again.`,
  };
  return failures[code] ??
    `xmd ${selected.tag.slice(1)} was not installed. The installed binary was not changed.\nReinstall xmd with:\ncurl -fsSL https://executable.md/install.sh | sh\nThen repeat the original upgrade command.`;
}

const downloadFailure = downloadResult.ok
  ? null
  : installationFailure(downloadResult.error.code);
```

<If condition={downloadFailure !== null}>
<Fail message={downloadFailure} />
</If>

Downloaded binary: {downloadResult.value.asset}
</If>

<If condition={authorized}>
Verifies the binary against its published SHA-256 checksum. Makes it executable
only after the checksum passes, then checks that it reports the selected
version.

<Upgrade.Verify candidate={downloadResult.value.candidate} as="verifyResult" />

```ts eval
const verifyFailure = verifyResult.ok
  ? null
  : installationFailure(verifyResult.error.code);
```

<If condition={verifyFailure !== null}>
<Fail message={verifyFailure} />
</If>

Verified: SHA-256 checksum and version {verifyResult.value.version}
</If>

<If condition={authorized}>
Atomically replaces the installed binary with the verified binary. Until
replacement succeeds, the installed binary remains unchanged.

<Upgrade.Replace candidate={verifyResult.value.candidate} as="replacementResult" />

```ts eval
const replacementFailure = replacementResult.ok
  ? null
  : installationFailure(replacementResult.error.code);
```

<If condition={replacementFailure !== null}>
<Fail message={replacementFailure} />
</If>

Installed xmd {replacementResult.value.installedVersion} (replaced {replacementResult.value.previousVersion}).
Binary: {replacementResult.value.executablePath}
Release notes: {replacementResult.value.releaseUrl}
</If>
