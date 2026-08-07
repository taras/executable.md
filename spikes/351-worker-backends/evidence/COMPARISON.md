# Comparison and recommendation for #346

#351 completes the evidence set: #347 measured bundled `workerd`, #349 measured
the Deno-local DOFS Workspace, and this spike measures what imperative
execution the Deno-local topology can carry on its own. The topology decision
has two separate questions.

## Question 1 — is Deno-local DOFS sufficient for the declarative durable core?

**Yes, on the evidence available.** The core the workflow needs is a durable,
coherent, identity-scoped filesystem, and #349 proved each property directly:
Cloudflare's unmodified DOFS schema over a file-backed `node:sqlite` adapter,
surviving full process restarts (including deletions and replacements),
isolating workspaces by database path, refusing a newer on-disk schema rather
than recreating it, and checkpointing to a single-file artifact on close — at
110 MB and 0.08 s per operation, in one process with no supervision surface.

The declarative components map onto primitives that already exist in that
layer: `<Dir>` onto `mkdir`, `<File>` onto `writeFile`/`readFile`, and
`<Branch>`/`<Commit>` onto DOFS's own git support, which Cloudflare drives
through the same filesystem (their `git` shell command is a thin shim over it).
This spike does not implement those components, per its scope; it confirms the
substrate exposes the operations they need, and that a host capability and an
imperative backend observe the same committed state in both directions
**[test]**.

The one caveat carried forward from #349: real FUSE — needed only for arbitrary
native subprocesses, which `xmd workflow` does not require — is blocked
in-process by a Deno uv-polyfill gap, and the userspace shim is development-only.
Neither bears on the declarative core.

## Question 2 — which imperative capabilities can safely layer on top?

**Worker Shell: include initially, scoped.** It runs natively, reuses
Cloudflare's adapter byte-identical, and its containment was measured rather
than assumed — ~50 escape attempts, zero leaks, no native-execution path at
all. Two conditions: run it inside a Deno Worker so a CPU-bound script cannot
starve the host (the measured hazard: 6.4 s of wall time with the abort timer
never firing), and describe it accurately as a workspace-scoped interpreter
with 83 built-ins, never as native command execution.

**Worker JavaScript: defer.** The full contract works — in-memory module graph
with no materialization, live-streamed output, capability access to DOFS,
returned values, errors, timeouts, cancellation — and it is genuinely useful.
But isolation holds only in a compiled artifact (a `deno run` host lets a
"locked" worker import `jsr:`/`npm:`), and CPU-bound user code cannot be
preempted at all. Since it is an optional extension over a declarative core,
the cost of shipping it now exceeds its value; revisit when Deno offers a CPU
or wall budget on `new Worker(...)`, or accept an out-of-process worker and its
startup cost.

## Is bundled `workerd` still necessary?

**Not for this scope.** #347's decisive advantage was that it runs Cloudflare's
real backends; this spike shows both of those execution models also run
natively in Deno over the same workspace, at a fraction of the weight — 139.7 MB
carrying *both* backends and DOFS, versus 191 MB for the workerd host, with
operations in tens of milliseconds rather than tenths of a second, and no child
process to supervise.

`workerd` remains the only option for the things this topology deliberately
does not provide: Cloudflare Containers, the hosted Workers surface (KV, R2,
Queues, Durable Object identity), and behavior guaranteed to match deployed
Cloudflare. If those enter scope, #347's evidence stands ready; they are not
required by the declarative workflow core.

## Recommendation

1. **Adopt** the Deno-local DOFS topology for the declarative durable workflow
   core.
2. **Include** Worker Shell initially, scoped: inside a Deno Worker, described
   as a workspace-scoped interpreter, with unsupported operations refused
   explicitly.
3. **Defer** Worker JavaScript until the preemption gap is resolved or an
   out-of-process cost is accepted.
4. **Omit** bundled `workerd` from the local topology, keeping #347 as the
   documented path if hosted-Cloudflare fidelity or Containers become
   requirements.

The final selection is recorded on #346; these spikes supply the evidence, not
the decision.
