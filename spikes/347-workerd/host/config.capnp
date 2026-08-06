# Base config: one Worker, one Durable Object namespace, SQLite state
# persisted through the `state` disk service. The state directory is a
# placeholder always overridden at launch with
# `--directory-path state=<abs path>`; the socket address is always
# overridden with `--socket-addr http=127.0.0.1:0`.
#
# workerd 1.20260804.1 rejects the documented `serve <config-file>
# <const-name>` selection when a file holds two Config constants, so the
# backends variant lives in config-backends.capnp instead of a second
# constant here.

using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .proofWorker),
    (name = "state", disk = (path = "do-state", writable = true)),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:0", http = (), service = "main"),
  ],
);

const proofWorker :Workerd.Worker = (
  modules = [
    (name = "worker.js", esModule = embed "worker.js"),
  ],
  compatibilityDate = "2026-08-04",
  compatibilityFlags = ["nodejs_compat"],
  durableObjectNamespaces = [
    (className = "ProofObject", uniqueKey = "xmd-spike-347", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "state"),
  bindings = [
    (name = "PROOF", durableObjectNamespace = "ProofObject"),
  ],
);
