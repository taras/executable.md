# The `xmd upgrade` command

* **Status:** Current
* **Scope:** How a standalone `xmd` binary replaces itself with a published
  release, and why every other installation refuses to.

---

A person who installed `xmd` from a release asset has no package manager to ask
for a new version. `xmd upgrade` is that command:

```console
$ xmd upgrade
Installed xmd 0.11.0 (previously 0.10.2).
Executable: /usr/local/bin/xmd
Release notes: https://github.com/taras/executable.md/releases/tag/v0.11.0
```

It selects the latest published stable release, downloads that release's binary
for this platform, verifies it against the release's own SHA-256 checksum,
requires the downloaded candidate to report the version that was selected, and
only then replaces the binary that is running with one atomic rename.

The whole of that policy — which release, how two versions compare, which
consent an install needs, what every refusal says — is a packaged Markdown
document the command executes. The host owns exactly what a document must never
be able to do: the installation lock, the bytes, the digest and the rename.

## Command grammar

```console
xmd upgrade [<tag>] [--status] [--allow-downgrade] [--allow-prerelease] [--journal <path>]
```

The one optional positional is an **exact tag**. Stable tags are `vX.Y.Z`;
prerelease tags are `vX.Y.Z-<SemVer-prerelease>`. Build metadata is refused.

The grammar is fixed and read from argv before anything else happens
(`scanUpgradeArgs` in `packages/cli/src/cli.ts`), because three things the
argument parser cannot report all mean a caller was answered by a command that
did something else:

- **An option this command does not define.** The parser stops at the first
  undefined token and drops the rest, so `--journal`, `--timeout` or `--raw`
  would be accepted in silence by a command that configures none of them.
- **A value written on a switch.** The parser resolves `--status=false` to the
  field's default, which is `false` — so the spelling that reads as "off" and
  the one that means "on" would both run an install. There is one way to write
  each switch.
- **A second positional.** The command installs exactly one release.

`--eval` and `--props-*` are refused ahead of that, by the shared props phase,
for the reason every non-`run` command refuses them.

Nothing else is offered. This command executes no caller's document, so an
include path, a journal, raw output, an agent, a permission mode, a workflow, a
timeout or a secret-detection switch would each describe work that does not
happen. `xmd upgrade --help` states the default, both consent options, the
entrypoint matrix, what verification does, and what the package-managed
alternatives are — and performs no release lookup, no lock, no file access, no
component execution and no host assembly work.

`--status` and `xmd workflow list --status=<state>` are two commands' options of
one name and different shapes. Each parses under its own command.

`--journal <path>` (`-j`) carries the same contract as `xmd run --journal`: the
path must not exist, the CLI creates it exclusively, and it holds one
current-run JSONL trace. The trace is evidence only. Upgrade never reads it,
appends to it, or treats it as continuation input, and a failed run keeps the
trace it produced. It changes no terminal text, release choice, consent,
attempt count or authority, and the ordinary secret gate filters it. In status
mode that file is the **sole** permitted filesystem change: status still takes
no installation lock, downloads no binary, creates no candidate and replaces
nothing.

## Which installations can self-upgrade

| Running `xmd` | macOS or Linux | Windows |
| --- | --- | --- |
| Compiled binary | Self-upgrade | Refuse; use the installer or the exact release asset |
| npm or Node | Refuse; update with npm | Refuse; update with npm |
| Bun | Refuse; update with Bun | Refuse; update with Bun |
| Deno or repository source | Refuse; update the package version or the checkout | Refuse; update the package version or the checkout |

**The command knows how this `xmd` is running, not how its files arrived.** A
package manager's database, `PATH`, a shell profile and the files beside the
binary all describe history, and history is what nothing here can observe
honestly. So any compiled macOS or Linux binary is eligible however that file
reached its path, and nothing is inspected to decide it.

The Deno entrypoint cannot tell a JSR invocation from a repository checkout —
both arrive as the same module under the same executable — so its one refusal
names both remedies rather than inventing a third provenance to choose between
them.

A compiled binary running on a platform the release does not publish for is
refused too, before anything is read: there is no artifact for it to ask for.

Every refusal happens before release lookup and before any filesystem change,
and says what happened, what did not happen, and the command or location that
resolves it.

## The packaged document owns the policy

`packages/cli/src/documents/upgrade-command.md` is an **ordinary streaming text
root** executing under the stable internal identity `<upgrade-command>`, located
from its own module
URL — never from the working directory and never through the component search
path (release spec §9). It owns:

- unsupported-entrypoint refusal and its presentation;
- exact-tag grammar and release selection;
- semantic-version parsing and comparison;
- consent relevance and refusal;
- the status, already-current and installation branches; and
- every successful and failed outcome's wording.

The exact text of all 36 user-facing outcomes — 33 the document returns or
raises, and three fixed grammar refusals in `packages/cli/src/cli.ts` — is the
approved corpus from the Planner's message refinement interview. Its rules are
worth stating because they are what a reader meets: the physical path is
labelled `Binary:`; a completed replacement says it *replaced* the previous
version; a repair command sits on its own line so it can be copied without being
reconstructed; a refusal names who manages the installation before giving the
remedy; and a refusal distinguishes what was not read from what was not changed.
Two of those messages carry contract corrections. A refused older prerelease
gives **one** command carrying both consents, because naming only one would walk
the reader into a second refusal. And the preparation-or-replacement failure no
longer calls the candidate verified, because the same code also covers staging
and permission failures that never reached verification.

It runs with an empty component search path, the fixed props below, canonical
core constructs, and the four host-declared phases below — and no general Files,
Process, Service, command, Fetch, Agent, Elicitation, workflow or repository
capability. Its durable stream is one invocation-local `InMemoryStream`, or the
exclusively created trace when `--journal` names one.

**The document's rendered body is the command's output.** It declares no root
`returns`, uses no `<Output>` region and no `<Return>`, so its root segments
enter `execution.output` in source order as each completes and reach the reader
while the next phase is still running. Each branch's description, phase call and
outcome live inside that branch, so a branch the command did not take
contributes no prose and no result.

Each installation phase is its own top-level segment rather than a nested one.
A segment's content reaches the reader only when that segment ends, so nesting
all four phases inside one `<If>` would hold the whole transcript until the last
rename finished — which is the synthesized final report this design replaced.

Control flow and presentation are Markdown; validation, comparison and
formatting are TypeScript `eval` blocks; there is no shell.

**Every entrypoint refusal is Markdown alone.** Each unsupported provenance, and
a compiled binary the release does not target, is one `<If>` around one `<Fail>`
carrying its own sentence — so a refused invocation compiles no eval block at
all. That is not a style choice: the npm package's `xmd upgrade` must answer
without asking its eval compiler to resolve anything, and the first block that
compiles would otherwise be doing exactly that on the one path where nothing is
supposed to happen. Tier UG counts the compilations and requires zero.

### Props

```yaml
requestedTag: string | null
status: boolean
allowDowngrade: boolean
allowPrerelease: boolean
installation:
  provenance: compiled | compiled-windows | deno-source | npm-node | bun-source
  currentVersion: string
  executablePath: string
  platform: string
  architecture: string
  target: string | null
```

Closed, and stated by the entrypoint. There is no `development` provenance,
because no entrypoint can observe one. There is no `busy` state either:
contention is learned when the installation is opened, which happens after the
document has settled the command line and the entrypoint.

### Selection

With no tag, the document selects the **first published non-draft release in
GitHub's own order whose tag parses as a stable version**. With a tag, it
selects only the published release carrying that exact tag. A draft, a missing
release and a malformed release tag are never installable, and an opt-in flag
never makes the implicit selection choose a prerelease.

### Version comparison

The npm `semver` package supplies validity and precedence. The document owns the
exact tag grammar around it: strip one required leading `v`, reject `+` build
metadata, parse in strict mode, and require the package's canonical version
string to equal the remaining input byte for byte. Comparison calls the
package's `compare()` on two validated canonical strings and never converts
through JavaScript `Number`.

`semver` compares numeric prerelease identifiers by converting them with
`Number`, so two that differ only past `Number.MAX_SAFE_INTEGER` are reported
equal — and the command would then tell somebody a release they do not have is
already installed. Precedence stays the package's; the document resolves only
that false equality, and only when the package answers `0` for two canonical
versions that are not the same string. It then compares the prerelease
identifiers of those canonical strings directly: numeric against numeric as
arbitrary-precision integers, a numeric identifier below an alphanumeric one,
otherwise lexically, with the shorter sequence lower. Nothing on that path
converts through `Number`.

### Consent

Consent authorizes replacement, not inspection and not a no-op.

- Installing an older release requires `--allow-downgrade`.
- Installing a prerelease requires an exact prerelease tag and
  `--allow-prerelease`; installing an older prerelease requires both.
- `--allow-prerelease` with no tag or a stable tag is irrelevant and refused,
  before any release is read.
- `--allow-downgrade` is refused after comparison unless the selection is older.
- `--status` accepts any published exact tag — stable, prerelease or older —
  without consent, so either consent option written with it is a command-line
  refusal rather than an ignored flag.
- An exact prerelease that is already installed needs no prerelease consent,
  because nothing is installed. `--allow-prerelease` still describes that
  selection and is accepted.

## The runtime-neutral host

`packages/cli/src/upgrade.ts` reads the packaged document, executes it through
`executeInstalled()` with the fixed props and the phases the assembly carries,
and — in the same scope, while the document is still producing — hands
`execution.output` to one caller-supplied consumer. It does not inspect the
runtime, resolve `PATH`, fetch, open the installation, or manufacture authority,
and it neither imports nor writes the host's stdout: which stream a transcript
lands on is the command line's decision.

- The interactive CLI consumer writes each chunk as it arrives.
- The non-TTY CLI consumer drains the same stream and writes it once at the end.
- Tests observe that same stream.

After the stream closes it returns the document's completion `Result` with no
value. A text root's completion value **is** the rendered text, and the consumer
already has it; handing it back would invite the caller to print everything
twice. A consumer that fails cancels the document and waits for teardown before
anything is reported. An uncaught execution or infrastructure failure comes back
as `Err` and the CLI reports it once after whatever transcript prefix already
reached the reader; it is never translated into an approved operational refusal.

Every runtime-named entrypoint supplies one closed `UpgradeAssembly`:

| Entrypoint | Provenance | Authority |
| --- | --- | --- |
| `compiled.ts` (win32) | `compiled-windows` | none |
| `compiled.ts` (other, no release target) | `compiled` | none |
| `compiled.ts` (macOS or Linux, published target) | `compiled` | the four phases below |
| `deno.ts` | `deno-source` | none |
| `node.ts` | `npm-node` | none |
| `bun.ts` | `bun-source` | none |

The assembly is a required parameter of `runXmd()`. A host that supplies no
authority gives the document no component through which anything could be read,
downloaded or replaced — which is what makes an unsupported entrypoint's refusal
structural rather than a check it could forget.

Help and `--version` are settled before `runUpgrade()`, so neither installs a
host operation nor performs any effect.

The compiled binary's eval block imports `semver` through a dynamic import that
`deno compile`'s TypeScript walk cannot see, because it never parses the
packaged Markdown. `upgrade.ts` therefore carries a static `import "semver"`
anchor so `--exclude-unused-npm` keeps the package in the binary, the same way
the eval compilers anchor their own standard imports. `semver` is a direct
dependency of `packages/cli`, not a transitive one, so source, npm and compiled
builds all resolve the same module. It is not added to core's global
`STANDARD_IMPORTS`: it is one command's policy dependency, not a built-in every
document gets.

## The two trusted components

An eligible compiled host declares exactly four phase components to canonical
execution, through the `ExecutionInstallation` passed to `executeInstalled()`.
Their factories close over one invocation's private state. None is exposed
through a contextual Api, public middleware, repository component lookup, the
ordinary `xmd run` profile or the public syntax catalog, so a user-authored
document cannot invoke one.

```
<Upgrade.Releases requestedTag={…} as="…" />   preflight, lock, release listing
<Upgrade.Download release={…} as="…" />        assets, bounded download, staging
<Upgrade.Verify   candidate={…} as="…" />      checksum, executable mode, version
<Upgrade.Replace  candidate={…} as="…" />      one same-directory rename
```

Splitting the trusted work into four phases is what gives Markdown honest points
at which to report progress; it moves no authority into the document. There is
one installation attempt per invocation, spent before the first asset request. A
candidate advances `downloaded → verified → committed` exactly once, so a
fabricated, cross-invocation, repeated or out-of-order identity is refused
before the next protected effect.

Each answers with the same closed shape: `{ ok, error: { code } | null, value }`.
Inside the host every outcome is an Effection `Result<T>`; the mapping to this
data happens at the JSON boundary so Markdown can present it. There is no local
TypeScript result union.

**Opaque identity is the authority boundary.** `Upgrade.Releases` mints an
invocation-local identity for every release it admits and retains the normalized
release privately. `Upgrade.Download` accepts only an identity present in that
map; `Upgrade.Verify` and `Upgrade.Replace` accept only a candidate this
invocation staged, in the state each requires. Anything else is refused
outright — not as a failure code, because a value nothing admitted is a claim of
authority that was never granted, and answering it with an outcome would make
the two indistinguishable. So the document may choose among the releases it was
shown, and cannot name another release, target, asset, checksum URL or
destination, skip verification, or replay a phase.

A detached release fact carries the tag, the draft and prerelease flags, the
canonical GitHub Release page URL, the asset names, and the identity. A download
hands back the public asset name and a candidate identity; verification hands
back that identity and the version it confirmed; replacement hands back the
installation summary. Nothing else crosses — never a staging path, bytes,
checksum contents, a handle or the private maps.

## Opening the installation

On an installation attempt, before any network access:

1. `lstat` the reported executable path **without resolving it**. A symbolic
   link is refused, and so is anything that is not a regular file. The path is
   the exact spelling the entrypoint was invoked as; a compiled binary preserves
   it through `process.execPath`, so a link is a refusal rather than a path to
   follow.
2. Require the parent directory to be writable, and prove it supports the
   create-then-rename the commit performs. `sudo` is never invoked, the
   installation is never relocated, and `PATH` is never consulted for a
   fallback.
3. Take one **non-blocking exclusive** advisory lock on a stable sidecar beside
   that exact executable (`<executable>.upgrade-lock`). Contention returns the
   `busy` refusal before any metadata transport, download or staging — waiting
   would turn "somebody else is installing" into a hang.
4. The sidecar is created and then left in place. Unlinking a locked path lets
   the next caller create and lock a different file at the same name while this
   lock is still held, which is two owners of one installation.

`Upgrade.Releases` owns this acquisition: it is the first trusted operation
after the document's fixed refusals and immediately precedes release lookup. `--status` skips all of it — it takes no lock, creates no probe and
changes nothing.

The unlock and close are registered on the enclosing upgrade-command scope
before anything can be acquired, so the lock survives `Upgrade.Releases`'
return, every later phase, the final report and cleanup, and any ending — a
refusal, a
failure, a cancellation, a killed process — gives it back. A killed process
runs no cleanup at all, and the kernel releases what it held; that released lock
is the only evidence an acquisition accepts that a previous holder is gone.

The acquisition is the one synchronous filesystem site in this package. The
descriptor and the record of who holds its lock have to become one invocation's
in a single uninterrupted step: suspending between them would leave a locked
descriptor nothing releases, and blocking the interpreter on the lock would stop
the cancellation that is the only thing left to end the wait. It carries the
narrow `local/no-sync-filesystem` exemption and names that invariant. All other
filesystem and process work is asynchronous.

## Release metadata

Anonymous HTTPS reads of `taras/executable.md` only, through GitHub's release
API. An exact tag reads the tag endpoint; a listing reads pages of 100 until a
short page proves it reached the end.

- Bounds: **32 pages** and **8 MiB** of metadata per command.
- Running out of either is a failure, never an answer. A partial list that
  looked complete would let "there is no stable release" be reported about a
  release that exists.
- A 404 from the exact-tag endpoint means *no such release*, which is the
  document's own missing-release message rather than a metadata defect.
- Every other non-2xx, a malformed body, a release missing or mistyping a
  required field, and two assets of one name are metadata failures.
- A release's canonical page URL must be this repository's page for **that
  release's own tag**, decoded and compared exactly. The page URL is the one
  thing in a release fact a reader is invited to go and check, so a payload
  naming one tag and linking another release's page never becomes a fact.
- The endpoint is built from constants and no response decides where the next
  request goes: a redirect is a non-2xx answer and ends the read.
- No token is sent, and no caller header is forwarded.

Markdown performs the selection over the normalized list, so equality, draft
filtering and tag validation stay visible.

## Download, verification and replacement

`Upgrade.Download` resolves the target and asset from the shared release
table (`packages/cli/src/release-targets.ts`) and requires the admitted release
to contain exactly that asset and one `checksums.txt`. There is no fallback to
another release or another target.

For both downloads:

- start at the canonical same-release URL,
  `https://github.com/taras/executable.md/releases/download/<tag>/<asset>`;
- follow at most **10** redirects manually;
- allow only the exact HTTPS hosts `github.com` and
  `release-assets.githubusercontent.com` — no suffix, wildcard, userinfo,
  alternate port or IP-host match;
- on `github.com`, require the decoded path to be **this** release's **this**
  asset exactly, not merely something under the repository's download path. A
  redirect to another tag or another asset in the same repository is still
  GitHub and still this project, and still the wrong bytes: the checksum set
  names one file, and a download that quietly became a different one is what
  verification cannot notice afterwards. GitHub's signed delivery host serves an
  opaque path it constructs, so the binding that matters already happened on the
  hop that produced the redirect;
- validate every `Location` before following it, and hold the final URL to the
  same allowlist;
- forward no authorization or caller header;
- stream rather than buffer; and
- close or abort response bodies on failure and on cancellation.

Bounds: **64 KiB** for `checksums.txt` and **256 MiB** for the binary. An
advertised or actual size over the bound is refused. The largest v0.10.2 release
binary is about 158 MB, so the binary bound is a real one with headroom rather
than a smaller accidental limit.

The candidate is staged in an invocation-owned randomly named file beside the
destination, created exclusively and **not executable**. The checksum set must
carry exactly one GNU `sha256sum` entry whose filename is the exact asset
basename and whose digest is 64 hexadecimal characters; none is a release that
cannot be verified and two is a release whose own record disagrees with itself.
The complete staged bytes are hashed with SHA-256 and compared as normalized
lowercase digests.

**Only after the digest matches** is the executable mode set. The staged
candidate is then run directly with `--version`, bounded to 30 seconds and
ordinary cancellation. It must exit zero and its stdout, after only its terminal
line ending is removed, must equal the selected tag without `v` exactly; stderr
and extra stdout never become the version.

The candidate is flushed and closed before the commit, and the commit is one
same-directory rename over the reported physical executable path. The installed
binary is never opened for writing, unlinked or truncated.

**Before the rename**, every failure and every cancellation leaves the installed
file byte-identical. **After it succeeds**, the candidate is authoritative:
cleanup removes only remaining scratch, and never restores the old bytes or
deletes the new binary. Completion facts — previous version, installed version,
executable path and release URL — are returned only after the rename. The old
process prints the result and exits; no detached helper is started.

On every path, responses, the candidate process, open files, temporary files and
directories are closed and then the lock is released. No cleanup continues in
the background.

## Nothing raw escapes, and nothing open is left behind

Every host operation this command performs is one a person has an answer for, so
none of them may raise past the phase that called it. A transport that refuses a
connection, a candidate process that cannot be spawned, a lock file that cannot
be opened, and a filesystem call that fails are each translated into the closed
failure the document has a sentence for. A raw error would end the document
before its own table could turn it into that sentence, and the person would read
a stack trace instead of what to do next.

That covers all three phases of a read, not just its start. **Acquiring** a
response, **processing** its body, and **releasing** it are each guarded. A
candidate-file write that fails reports it as this read's own result rather than
raising through the download body — the route by which a full disk once escaped
the installation phase entirely and bypassed the approved replacement refusal. A
response whose own release raises is teardown, not an outcome: it changes no
answer.

Resource discipline follows the same rule, registered before the thing it
protects can exist:

- the topology probe creates **each** of its two names exclusively, and records
  a name for removal only once that create has succeeded. A name that already
  belongs to another process is therefore never deleted by this command's
  cleanup, and the destination name is never renamed over: it is created
  exclusively first, which is both halves of what the commit itself later does.
  Each descriptor is closed by leaving the scope that opened it, whether the
  create succeeded, the close failed, or the whole probe was cancelled;
- the staged candidate's descriptor belongs to the staging scope, so a failed
  download, a failed flush and a cancellation all close it;
- a chunk is written completely, looping on the bytes actually stored. `write`
  may store fewer than it was given, and a candidate missing the remainder is a
  file whose digest was computed over bytes that never reached the disk — it
  would fail its checksum for a reason that says nothing about the release; and
- a staging path becomes this invocation's to remove **only once its exclusive
  create has succeeded**. The create is what makes the file ours; a path that
  already existed belongs to somebody else, and recording it before the create
  would have teardown delete a stranger's file.

Filesystem work goes through `@effectionx/fs` — `lstat` and `rm` here — and
`until` is retained only for the asynchronous primitives that package does not
provide: `open`, `rename`, `chmod` and the writable-mode `access`.

## Private state

None of the following ever enters document props, bindings, interpolation,
output or the in-memory journal:

- response handles and credentials;
- downloaded bytes and digest state;
- the open lock handle;
- temporary paths;
- the staged executable; and
- the private admitted-release map.

The physical installed executable path is an allowed fixed prop and a successful
output field. Physical temporary paths are not.

## Exit status and output

| Outcome | Status |
| --- | --- |
| Parser, lookup, validation, consent, topology, integrity or replacement failure | 1 |
| A completed status comparison, for all three orderings | 0 |
| An already-current installation | 0 |
| A successful replacement, after the atomic rename has won | 0 |

The transcript is the output. It is the document's rendered body, delivered to
stdout: each root segment reaches the reader as it completes, so an install
shows `Selected release`, then `Downloaded binary`, then `Verified`, then the
installation summary — each before the following phase begins. A refusal keeps
every segment already rendered, claims nothing unfinished, and the CLI reports
the approved message once on stderr after that prefix.

Status output carries the installed version, the selected tag with its ordering,
the exact release URL, and a statement that no files changed. Already-current
output carries the installed version, the executable path, the exact release URL
and a statement that no replacement was needed. Successful installation output
carries the previous version, the installed version, the physical executable
path and the exact release URL. All of these are rendered by the branch that
produced them; none is a value the command returns and prints.

An inactive branch contributes no prose, but the engine still emits the blank
lines that surrounded it. The runner collapses runs of newlines and ends the
transcript with exactly one, holding back only whitespace — text is passed on as
it arrives, so collapsing costs nothing in progressiveness.

## Acceptance

Tier UG is `packages/cli/tests/upgrade-command-document.test.ts` and runs under
Deno, Node and Bun: it executes the exact packaged document with deterministic
phase components declaring the production schemas, an empty include list, and
tripwires that refuse every host capability. Tier UO
(`packages/cli/tests/upgrade-output.test.ts`) owns how the transcript reaches a
reader. Tier UC is
`packages/cli/tests/upgrade-cli.test.ts`, which shells out under whichever
runtime it is running, so the same file proves each entrypoint's own refusal.
Tier UH is `packages/cli/tests/compiled-upgrade.test.ts` and runs under Deno
alone, because the installation lock is a real advisory lock raced against a
real Deno child.

| # | Test | Verify |
|---|------|--------|
| UC1–UC3 | Grammar and inert help | The command row carries its settled description; command help states the default, both consent options, the matrix in named platforms, and what verification does, while performing none of it; nothing a run configures is offered |
| UC4–UC8 | Command line before policy | An undefined option, a value on a switch, a second positional, `--eval` and `--props-*` are each refused with the CLI's own message and no policy answer; each entrypoint states its own remedy; `xmd workflow` keeps its own `--status` |
| UG1–UG11 | Selection, consent and the three endings | The latest published stable is selected over a draft and a prerelease and installed; `--status` reports the ordering and installs nothing; an already-current selection downloads nothing; older and prerelease selections each require their consent and install with it, an older prerelease requires both; consent that describes nothing is refused, irrelevant prerelease consent before any read and irrelevant downgrade consent after the comparison; `--status` refuses either consent option and accepts any published exact tag; a draft, a missing tag and a listing with no stable release are each refused by name |
| UG12–UG15 | Authority and answers | Each unsupported provenance and an untargeted compiled binary refuse with no release read and no install; every release-read and installation failure code reaches its own actionable message, and an unknown code reaches the fallback |
| UG16–UG20 | Comparison and shape | Stable and prerelease precedence, numeric against non-numeric identifiers, different-length sequences, identifiers past the safe-integer range and the package's own boundary there; leading zeros, a missing `v`, build metadata, whitespace and malformed separators refused before any read; a release whose own tag is malformed is never selected; the approved headings in the approved order |
| UH1–UH2 | Shared identity | Every platform maps to the exact artifact the release publishes, an unpublished platform maps to none, and only an eligible compiled host carries the components at all |
| UH3–UH7 | The real path | A real download, digest, executable mode, candidate `--version` and rename replace the bytes once and report the exact facts; `--status` requests only the listing and leaves no sidecar, staging or probe; an exact tag reads the tag endpoint; a 404 is a missing release; a draft never installs |
| UH8–UH10 | Metadata and release records | Malformed, wrong-shaped, foreign, self-contradicting, oversized and never-ending metadata are each refused as metadata, and an incomplete listing is never reported as an empty one; a release missing this target's binary or its checksums is refused from its own record before a byte is requested; a checksum set must name the binary exactly once |
| UH11–UH13 | The gates before replacement | A checksum mismatch stops before the candidate is made executable or run; a candidate that exits nonzero, times out, prints something else or reports another version never replaces anything; stdout is the version only after its own terminal line ending |
| UH14–UH17 | Transport and commit | A redirect to another host, a suffix host, userinfo, an alternate port, plain HTTP or another repository's path is refused, GitHub's signed delivery host is followed, and the hop ceiling ends a loop; short, oversized, over-advertised, interrupted and failed downloads never install; a failed replacement leaves the original byte-identical |
| UH18–UH21 | Owning the installation | An invoked symbolic link is refused without being resolved and without a request; a non-regular destination and an unwritable parent are refused before the network; a second upgrade of one installation is refused rather than queued while a real child holds the lock, and succeeds once the kernel has released it |
| UH22–UH26 | Cancellation, authority and status | Cancelling before the commit keeps the original and leaves no candidate; cancelling after it keeps the new binary and completes teardown; every request carries only a URL and an accept header; a release identity this invocation never minted is refused outright; the process status follows the outcome |
| UH27–UH28 | Binding a download to one release | A redirect that stays on `github.com`, in this repository and under the download path but names another tag or another platform's asset is refused before it is requested; a release whose page URL names another tag never becomes a fact, while the same payload with its own page is admitted |
| UH29–UH31 | Containment and ownership | A transport, a candidate process and a lock that each raise become the document's own answers rather than stack traces; a staging path that already exists is left byte-identical, because the exclusive create is what would have made it ours |
| UH39 | Phase order | Replace before Verify, a second download, and a repeated Verify are each refused before the next protected effect, with nothing committed |
| UO1 | Progressive output | Each milestone has reached the reader before the next phase begins; a buffered run produces the same bytes, so only this ordering tells them apart |
| UO2–UO3 | One output path | Two consumers of the same stream receive identical bytes, the completion value carries no text to print again, and a failing consumer cancels the run |
| UO4 | Journal is evidence | A run writes durable events and reads none back; a second run repeats the work rather than resuming |
| UC9–UC11 | Diagnostic journal | `--journal` and `-j` create one new trace, leave terminal bytes identical, keep a failed run's trace, refuse an existing path without touching it, and refuse a missing path before the document runs |
| UC12 | Private profile | `xmd syntax` lists no `Upgrade.*`, and an ordinary document naming one cannot resolve it |
| UH32–UH33 | Complete writes | A sink storing one byte per call still receives every byte exactly once, asking only for what is left; a sink that stops accepting bytes, or raises, fails rather than truncating |
| UH34 | A failing write through the component | A candidate write that fails part-way through a real download reaches the approved replacement refusal whole, with the installed bytes unchanged, no commit, no staging residue, and the descriptor closed |
| UH35–UH36 | Probe ownership | A file already at either probe name is neither deleted nor renamed over, the topology question is answered "no" instead, and nothing is requested; on the ordinary path both names are still removed |
| UH37 | Descriptor teardown | Cancelling mid-download closes the candidate's descriptor rather than only unlinking its path |
