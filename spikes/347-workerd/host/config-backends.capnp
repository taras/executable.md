# Backends config: identical to config.capnp plus the Worker Loader binding
# the Computer worker-shell and worker-javascript backends require. Same
# Durable Object uniqueKey, so both configs address the same persisted state.

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
    (name = "LOADER", workerLoader = (id = "spike-347-loader")),
  ],
);
