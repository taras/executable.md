using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .mainWorker),
    (name = "do-storage", disk = (path = "do-state", writable = true)),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:0", http = (), service = "main"),
  ],
);

const mainWorker :Workerd.Worker = (
  modules = [
    (name = "worker.js", esModule = embed "worker.js"),
  ],
  compatibilityDate = "2026-08-04",
  compatibilityFlags = ["nodejs_compat"],
  durableObjectNamespaces = [
    (
      className = "Agent",
      uniqueKey = "container-probe-agent",
      enableSql = true,
      container = (imageName = "probe-computerd"),
    ),
  ],
  durableObjectStorage = (localDisk = "do-storage"),
  bindings = [
    (name = "AGENT", durableObjectNamespace = "Agent"),
  ],
  containerEngine = (localDocker = (
    socketPath = "unix:/Users/tarasmankovski/.docker/run/docker.sock",
    containerEgressInterceptorImage = "cloudflare/proxy-everything:main",
  )),
);
