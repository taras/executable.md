# Composability scope

Date: 2026-11-08

## Context

The pre-migration `AGENTS.md` (`448fb49e^`, Setup and Verification) records that
composability reran the runtime suites, typechecks and other correctness checks
that `green` already required. Those repeated suites cost 26 of the job's 31
minutes for no new information about ownership
([issue #546](https://github.com/taras/executable.md/issues/546)). These numbers
record that investigation, not a timing requirement.

## Decision

Composability stages the interference between the real browser build and Deno,
Node and Bun consumers. Its purpose is ownership and non-interference; it is
not a correctness check. Product correctness remains with the checks `green`
already requires. The clean-checkout harness supplies the preparation and
offline-build envelope around the same interference proof.

## Current owners

- [Testing — Composability proves ownership](../testing-spec.md#composability-proves-ownership)
- [AGENTS.md — Verification](../../AGENTS.md#verification)
