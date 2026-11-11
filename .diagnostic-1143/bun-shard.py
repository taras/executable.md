#!/usr/bin/env python3
"""Capture safe operation markers outside the original Bun shard's process group."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import threading
import time

SOURCE = "345c53ec81645eed8025592cd79b4a3d19d9115f"
FIXTURE = b"packages/cli/tests/adversarial-implementation.test.ts:"
TIMEOUT = b"Implementation fixture journeys** failed (timeout): test timed out after 120 seconds"
HERE = Path(__file__).resolve().parent
EVENT_FIELDS = {"pid", "instance", "at", "kind", "id", "name", "location", "state", "compare", "exitCode"}


def epoch_ms():
    return time.time_ns() // 1_000_000


class Capture:
    def __init__(self):
        self.server = socket.socket(socket.AF_INET)
        self.server.bind(("127.0.0.1", 0))
        self.port = self.server.getsockname()[1]
        self.server.listen(64)
        self.server.settimeout(0.1)
        self.events = []
        self.disconnects = []
        self.errors = []
        self.readers = []
        self.stop = threading.Event()
        self.listener = threading.Thread(target=self.accept)
        self.listener.start()

    def accept(self):
        while not self.stop.is_set():
            try:
                client, _ = self.server.accept()
            except socket.timeout:
                continue
            reader = threading.Thread(target=self.read, args=(client,), daemon=True)
            self.readers.append(reader)
            reader.start()

    def read(self, client):
        identity = None
        try:
            with client, client.makefile("rb") as stream:
                while line := stream.readline(8193):
                    if len(line) > 8192:
                        raise ValueError("oversized attribution marker")
                    event = json.loads(line)
                    if set(event) - EVENT_FIELDS:
                        raise ValueError("unrecognized attribution field")
                    if len(self.events) >= 50000:
                        raise ValueError("attribution marker cap reached")
                    identity = (event["pid"], event["instance"])
                    self.events.append(event)
        except (OSError, ValueError, KeyError, TypeError) as error:
            self.errors.append(type(error).__name__)
        finally:
            if identity is not None:
                self.disconnects.append({"pid": identity[0], "instance": identity[1], "at": epoch_ms()})

    def finish(self):
        self.stop.set()
        self.listener.join()
        self.server.close()
        end = time.monotonic() + 10
        for reader in self.readers:
            reader.join(max(0, end - time.monotonic()))
        return {
            "events": self.events,
            "disconnects": self.disconnects,
            "errors": self.errors,
            "connectionsStillOpen": sum(reader.is_alive() for reader in self.readers),
        }


def command_output(argv, source):
    return subprocess.check_output(argv, cwd=source, text=True).strip()


def render_observer(source, path, port):
    template = (HERE / "observer.mjs.in").read_text()
    imports = {
        "__CORE__": "packages/core/api.ts",
        "__RUNTIME__": "packages/runtime/mod.ts",
        "__GIT__": "packages/git/api.ts",
    }
    for token, relative in imports.items():
        template = template.replace(token, json.dumps(str(source / relative)))
    path.write_text(template.replace("__PORT__", str(port)))


def write_shim(directory, deno, observer):
    directory.mkdir()
    shim = directory / "deno"
    shim.write_text(
        "#!/usr/bin/env python3\n"
        "import os, sys\n"
        "args = sys.argv[1:]\n"
        "if any(a.endswith('/packages/cli/src/deno.ts') for a in args) and "
        "any(a.startswith('<Testing><Fixture.Implementation ') for a in args):\n"
        f"    args += ['--plugin', {str(observer)!r}]\n"
        f"os.execv({deno!r}, ['deno'] + args)\n"
    )
    shim.chmod(0o755)


def collect_output(stream, path, channel, markers):
    with stream, path.open("wb") as output:
        for line in stream:
            output.write(line)
            if FIXTURE in line:
                markers.append({"kind": "carrier-header", "at": epoch_ms(), "channel": channel})
            if TIMEOUT in line:
                markers.append({"kind": "reported-timeout", "at": epoch_ms(), "channel": channel})
            if b"runs the Implementation Markdown journeys without native models [" in line:
                markers.append({"kind": "carrier-result", "at": epoch_ms(), "channel": channel})


def run(source, out, smoke):
    out.mkdir(parents=True, exist_ok=False)
    head = command_output(["git", "rev-parse", "HEAD"], source)
    pre_status = command_output(["git", "status", "--porcelain=v1"], source)
    if pre_status or (not smoke and head != SOURCE):
        raise ValueError("diagnostic requires the clean, pinned source")

    deno = shutil.which("deno")
    bun = shutil.which("bun")
    if deno is None or bun is None:
        raise ValueError("expected Deno and Bun executables")
    versions = {
        "bun": command_output([bun, "--version"], source),
        "deno": command_output([deno, "--version"], source).splitlines()[0],
    }
    if not smoke and (
        os.uname().sysname != "Linux"
        or versions["bun"] != "1.4.0"
        or versions["deno"].split()[:2] != ["deno", "2.9.5"]
    ):
        raise ValueError(f"unexpected hosted toolchain {versions}")

    capture = Capture()
    observer = out / "observer.mjs"
    render_observer(source, observer, capture.port)
    shim = out / "bin"
    write_shim(shim, deno, observer)
    env = dict(os.environ)
    env["PATH"] = str(shim) + os.pathsep + env["PATH"]
    env["XMD_TEST_ARTIFACTS"] = str(out / "failure-journals")
    argv = [bun, "run", "test:bun", "9/10"]
    if smoke:
        sample = '<Testing><Test name="benign diagnostic smoke" timeout="20s">\n```sh exec\nsleep 15\n```\n</Test></Testing>'
        argv = [deno, "run", "--allow-all", "--node-modules-dir=manual", "--cached-only",
                "--frozen", str(source / "packages/cli/src/deno.ts"), "run",
                "--allow-absolute", "--eval", sample, "--plugin", str(observer)]

    markers = []
    started = epoch_ms()
    with subprocess.Popen(argv, cwd=source, env=env, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, start_new_session=True) as process:
        readers = []
        for channel in ("stdout", "stderr"):
            reader = threading.Thread(target=collect_output,
                                      args=(getattr(process, channel), out / f"{channel}.log", channel, markers))
            reader.start()
            readers.append(reader)
        if smoke:
            end = time.monotonic() + 15
            while process.poll() is None and time.monotonic() < end:
                if any(event["kind"] == "exec-start" for event in capture.events):
                    os.killpg(process.pid, signal.SIGKILL)
                    break
                time.sleep(0.02)
        code = process.wait()
        for reader in readers:
            reader.join()
    captured = capture.finish()
    (out / "progress.json").write_text(json.dumps(captured))
    post_status = command_output(["git", "status", "--porcelain=v1"], source)
    receipt = {
        "head": head,
        "postHead": command_output(["git", "rev-parse", "HEAD"], source),
        "postStatus": post_status,
        "argv": argv,
        "versions": versions,
        "worker": list(os.uname()),
        "cpuCount": os.cpu_count(),
        "runId": os.environ.get("GITHUB_RUN_ID"),
        "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "startedAtEpochMs": started,
        "elapsedMs": epoch_ms() - started,
        "returnCode": code,
        "events": len(captured["events"]),
        "captureErrors": captured["errors"],
        "connectionsStillOpen": captured["connectionsStillOpen"],
        "carrierMarkers": markers,
        "channelHashes": {name: hashlib.sha256((out / name).read_bytes()).hexdigest()
                          for name in ("stdout.log", "stderr.log", "progress.json", "observer.mjs")},
    }
    (out / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt))
    if captured["errors"] or captured["connectionsStillOpen"] or post_status or receipt["postHead"] != head:
        raise ValueError("incomplete capture or source changed")
    if smoke:
        assert code == -signal.SIGKILL
        assert any(event["kind"] == "exec-start" for event in captured["events"])
        assert not any(event["kind"] == "exec-end" for event in captured["events"])
        return 0
    if not any(event.get("name") == "Fixture.Implementation" for event in captured["events"]):
        raise ValueError("the shard did not enter the instrumented fixture")
    return code


parser = argparse.ArgumentParser()
parser.add_argument("source", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--smoke", action="store_true")
args = parser.parse_args()
raise SystemExit(run(args.source.resolve(), args.output.resolve(), args.smoke))
