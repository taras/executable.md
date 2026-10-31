import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFile } from "node:child_process";
// src/acp/client-process.ts
const PROCESS_HELPER_TIMEOUT_MS = 8e3;
const PROCESS_HELPER_MAX_BUFFER_BYTES = 33554432;
async function runTimedExecFile(command, args, options = {}) {
	const timeoutMs = Math.max(1, Math.round(options.timeoutMs ?? 8e3));
	return await new Promise((resolve, reject) => {
		let settled = false;
		let timer;
		const child = execFile(command, [...args], {
			encoding: "utf8",
			maxBuffer: options.maxBufferBytes ?? 33554432,
			killSignal: "SIGKILL",
			windowsHide: options.windowsHide,
			env: options.env
		}, (error, stdout) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (error) {
				reject(error);
				return;
			}
			resolve(stdout);
		});
		timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			const killed = child.kill("SIGKILL");
			child.stdout?.destroy();
			child.stderr?.destroy();
			child.unref();
			reject(Object.assign(/* @__PURE__ */ new Error(`${command} timed out after ${timeoutMs}ms`), {
				code: "ETIMEDOUT",
				killed,
				signal: "SIGKILL"
			}));
		}, timeoutMs);
	});
}
function normalizeAgentCommandInput(value) {
	if (typeof value === "string") return { agentCommand: value };
	const parts = toCommandParts([...value]);
	const argv = [parts.command, ...parts.args];
	return {
		agentCommand: renderArgvIdentity(argv),
		agentArgv: argv
	};
}
const IDENTITY_SAFE_ARG_RE = /^[A-Za-z0-9_@%+=:,./^~-]+$/u;
function renderArgvIdentity(argv) {
	return argv.map((arg) => IDENTITY_SAFE_ARG_RE.test(arg) ? arg : JSON.stringify(arg)).join(" ");
}
function isoNow() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function waitForSpawn(child) {
	return new Promise((resolve, reject) => {
		const onSpawn = () => {
			child.off("error", onError);
			resolve();
		};
		const onError = (error) => {
			child.off("spawn", onSpawn);
			reject(error);
		};
		child.once("spawn", onSpawn);
		child.once("error", onError);
	});
}
function isChildProcessRunning(child) {
	return child.exitCode == null && child.signalCode == null;
}
function requireAgentStdio(child) {
	if (!child.stdin || !child.stdout || !child.stderr) throw new Error("ACP agent must be spawned with piped stdin/stdout/stderr");
	return child;
}
function waitForChildExit(child, timeoutMs) {
	if (!isChildProcessRunning(child)) return Promise.resolve(true);
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			finish(false);
		}, Math.max(0, timeoutMs));
		const finish = (value) => {
			if (settled) return;
			settled = true;
			child.off("close", onExitLike);
			child.off("exit", onExitLike);
			clearTimeout(timer);
			resolve(value);
		};
		const onExitLike = () => {
			finish(true);
		};
		child.once("close", onExitLike);
		child.once("exit", onExitLike);
	});
}
function resolveAgentCommandParts(value, argv, platform = process.platform) {
	if (argv) {
		const parts = toCommandParts([...argv]);
		assertWindowsLaunchableCommand(parts.command, platform);
		return parts;
	}
	if (platform === "win32") throw new Error("Raw agent command strings are not supported on Windows. Configure the agent with an argv array, for example: \"argv\": [\"agent.exe\", \"--acp\"]. Legacy agents.<name>.args arrays are migrated automatically. Existing sessions without saved argv must be closed and recreated.");
	return splitCommandLine(value);
}
function assertWindowsLaunchableCommand(command, platform) {
	if (platform === "win32" && path.extname(command).toLowerCase() === ".sh") throw new Error(`Windows cannot launch shell script executable "${command}" directly. Configure an explicit interpreter argv, for example: "argv": ["bash", "${command}"]. acpx does not infer interpreters.`);
}
function splitCommandLine(value) {
	const state = {
		current: "",
		quote: null,
		escaping: false,
		parts: [],
		hasPart: false
	};
	for (const ch of value) readCommandLineChar(state, ch);
	if (state.escaping) {
		state.current += "\\";
		state.hasPart = true;
	}
	if (state.quote) throw new Error("Invalid --agent command: unterminated quote");
	flushCommandLinePart(state);
	return toCommandParts(state.parts);
}
function toCommandParts(parts) {
	if (parts.length === 0 || parts[0] === "") throw new Error("Invalid --agent command: empty command");
	return {
		command: parts[0],
		args: parts.slice(1)
	};
}
function readCommandLineChar(state, ch) {
	if (state.escaping) {
		state.current += ch;
		state.escaping = false;
		state.hasPart = true;
	} else if (ch === "\\" && state.quote !== "'") state.escaping = true;
	else if (state.quote) {
		if (ch === state.quote) state.quote = null;
		else state.current += ch;
		state.hasPart = true;
	} else readUnquotedCommandLineChar(state, ch);
}
function readUnquotedCommandLineChar(state, ch) {
	if (ch === "'" || ch === "\"") {
		state.quote = ch;
		state.hasPart = true;
	} else if (/\s/.test(ch)) flushCommandLinePart(state);
	else {
		state.current += ch;
		state.hasPart = true;
	}
}
function flushCommandLinePart(state) {
	if (state.hasPart) {
		state.parts.push(state.current);
		state.current = "";
		state.hasPart = false;
	}
}
function asAbsoluteCwd(cwd) {
	return path.resolve(cwd);
}
async function resolveAgentSessionCwd(cwd, agentCommand, options = {}) {
	const resolved = asAbsoluteCwd(cwd);
	if (!shouldTranslateWslWindowsCwd(agentCommand, options)) return resolved;
	const translated = (await (options.runWslpath ?? runWslpath)(resolved)).trim();
	if (!translated) throw new Error(`wslpath returned an empty Windows path for cwd: ${resolved}`);
	return translated;
}
function shouldTranslateWslWindowsCwd(agentCommand, options) {
	if (!isWsl(options)) return false;
	try {
		const { command } = splitCommandLine(agentCommand);
		return isWindowsExecutableCommand(command);
	} catch {
		return false;
	}
}
function isWsl(options) {
	if ((options.platform ?? process.platform) !== "linux") return false;
	return (options.existsSync ?? fs.existsSync)("/proc/sys/fs/binfmt_misc/WSLInterop");
}
const WINDOWS_EXECUTABLE_EXTENSION_RE = /\.(?:exe|cmd|bat)$/u;
function isWindowsExecutableCommand(command) {
	const normalized = command.toLowerCase();
	return WINDOWS_EXECUTABLE_EXTENSION_RE.test(normalized);
}
async function runWslpath(cwd) {
	return await runTimedExecFile("wslpath", ["-w", cwd]);
}
function basenameToken(value) {
	return path.basename(value).toLowerCase().replace(/\.(cmd|exe|bat)$/u, "");
}
// src/spawn-command-options.ts
function readWindowsEnvValue(env, key) {
	const matchedKey = Object.keys(env).find((entry) => entry.toUpperCase() === key);
	return matchedKey ? env[matchedKey] : void 0;
}
function windowsExecutableExtensions(env) {
	return (readWindowsEnvValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0);
}
function commandCandidates(command, env) {
	if (path.extname(command).length > 0) return [command];
	return windowsExecutableExtensions(env).map((extension) => `${command}${extension}`);
}
function commandHasPath(command) {
	return command.includes("/") || command.includes("\\") || path.isAbsolute(command);
}
function resolveWindowsPathCommand(command, env, cwd) {
	const candidates = commandCandidates(command, env);
	const pathValue = readWindowsEnvValue(env, "PATH");
	if (!pathValue) return;
	for (const directory of pathValue.split(";")) {
		const resolved = findExistingCommandInDirectory(directory, candidates, cwd);
		if (resolved) return resolved;
	}
}
function findExistingCommandInDirectory(directory, candidates, cwd) {
	const trimmedDirectory = directory.trim();
	if (trimmedDirectory.length === 0) return;
	return candidates.map((candidate) => fromWorkingDirectory(path.join(trimmedDirectory, candidate), cwd)).find((resolved) => fs.existsSync(resolved));
}
function fromWorkingDirectory(value, cwd) {
	return cwd !== void 0 && !path.isAbsolute(value) ? path.resolve(cwd, value) : value;
}
function resolveWindowsWrapperToken(token, wrapperPath) {
	const relative = token.match(/%~?dp0%?\s*[\\/]*(.*)$/i)?.[1]?.trim();
	if (!relative) return;
	const candidate = path.resolve(path.dirname(wrapperPath), relative.replace(/[\\/]+/g, path.sep).replace(/^[\\/]+/, ""));
	return path.extname(candidate).toLowerCase() === ".exe" && fs.existsSync(candidate) ? candidate : void 0;
}
function resolveWindowsWrapperExecutable(wrapperPath) {
	if (!fs.existsSync(wrapperPath)) return;
	try {
		return [...fs.readFileSync(wrapperPath, "utf8").matchAll(/"([^"\r\n]*)"/g)].map((match) => resolveWindowsWrapperToken(match[1] ?? "", wrapperPath)).find((candidate) => candidate !== void 0);
	} catch {
		return;
	}
}
function resolveWindowsCommand(command, env = process.env, cwd) {
	const candidates = commandCandidates(command, env);
	if (commandHasPath(command)) return candidates.map((candidate) => fromWorkingDirectory(candidate, cwd)).find((candidate) => fs.existsSync(candidate));
	return resolveWindowsPathCommand(command, env, cwd);
}
/**
* Resolve a Windows command to a native executable suitable for direct spawn.
*
* Batch and PowerShell shims are intentionally rejected unless they point at a
* real `.exe` entrypoint. Callers that need shell execution should use the
* command-specific shell policy instead.
*/
function resolveWindowsExecutablePath(command, env = process.env, cwd) {
	const resolved = resolveWindowsCommand(command, env, cwd);
	if (!resolved) return;
	const absolute = path.resolve(resolved);
	const extension = path.extname(absolute).toLowerCase();
	if (extension === ".exe") return absolute;
	if (extension !== ".cmd" && extension !== ".bat" && extension !== ".ps1") return;
	const siblingExecutable = `${absolute.slice(0, -extension.length)}.exe`;
	return fs.existsSync(siblingExecutable) ? siblingExecutable : resolveWindowsWrapperExecutable(absolute);
}
function shouldUseWindowsBatchShell(command, platform = process.platform, env = process.env, cwd) {
	if (platform !== "win32") return false;
	const resolvedCommand = resolveWindowsCommand(command, env, cwd) ?? command;
	const ext = path.extname(resolvedCommand).toLowerCase();
	return ext === ".cmd" || ext === ".bat";
}
const CMD_META_CHAR_RE = /([()\][%!^"`<>&|;, *?])/gu;
const CMD_SHIM_RE = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/iu;
function escapeCmdCommand(value) {
	return value.replace(CMD_META_CHAR_RE, "^$1");
}
function escapeCmdArgument(value, doubleEscapeMeta) {
	const escaped = `"${escapeBackslashesForQuoting(value)}"`.replace(CMD_META_CHAR_RE, "^$1");
	return doubleEscapeMeta ? escaped.replace(CMD_META_CHAR_RE, "^$1") : escaped;
}
function escapeBackslashesForQuoting(value) {
	let result = "";
	let backslashes = 0;
	for (const char of value) {
		if (char === "\\") {
			backslashes += 1;
			continue;
		}
		result += "\\".repeat(char === "\"" ? backslashes * 2 + 1 : backslashes) + char;
		backslashes = 0;
	}
	return result + "\\".repeat(backslashes * 2);
}
function buildAgentSpawnCommand(command, args, platform = process.platform, env = process.env, cwd) {
	if (!shouldUseWindowsBatchShell(command, platform, env, cwd)) return {
		command,
		args: [...args]
	};
	const resolvedCommand = path.win32.normalize(resolveWindowsCommand(command, env, cwd) ?? command);
	const doubleEscapeMeta = CMD_SHIM_RE.test(resolvedCommand);
	const shellCommand = [escapeCmdCommand(resolvedCommand), ...args.map((arg) => escapeCmdArgument(arg, doubleEscapeMeta))].join(" ");
	return {
		command: readWindowsEnvValue(env, "COMSPEC") ?? "cmd.exe",
		args: [
			"/d",
			"/s",
			"/c",
			`"${shellCommand}"`
		],
		windowsVerbatimArguments: true
	};
}
function buildSpawnCommandOptions(command, options, platform = process.platform, env = process.env, cwd) {
	if (!shouldUseWindowsBatchShell(command, platform, env, cwd)) return options;
	return {
		...options,
		shell: true
	};
}
function buildTerminalSpawnCommand(command, args) {
	return {
		command,
		args: args ?? [],
		killProcessGroup: false
	};
}
function buildTerminalShellSpawnCommand(command, platform = process.platform) {
	if (platform === "win32") return {
		command: "cmd.exe",
		args: [
			"/d",
			"/s",
			"/c",
			command
		],
		killProcessGroup: true
	};
	return {
		command: "/bin/sh",
		args: ["-c", command],
		killProcessGroup: true
	};
}
/** Finds an installed entrypoint without executing it. */
function resolveInstalledExecutable(command) {
	if (process.platform === "win32") {
		const resolved = resolveWindowsCommand(command);
		return resolved && fs.statSync(resolved, { throwIfNoEntry: false })?.isFile() ? path.resolve(resolved) : void 0;
	}
	return (command.includes("/") ? [path.resolve(command)] : (process.env.PATH ?? "").split(path.delimiter).map((directory) => path.resolve(directory, command))).find((candidate) => {
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return fs.statSync(candidate).isFile();
		} catch {
			return false;
		}
	});
}
// src/agent-registry.ts
const ACP_ADAPTER_PACKAGE_RANGES = {
	pi: "^0.0.33",
	codex: "^1.1.5",
	claude: "^0.95.0",
	mux: "^0.28.0"
};
const AGENT_DEFINITIONS = {
	pi: {
		name: "Pi",
		argv: ["npx", `pi-acp@${ACP_ADAPTER_PACKAGE_RANGES.pi}`],
		installedArgv: ["pi-acp"],
		requiredCommands: ["pi"],
		package: {
			packageName: "pi-acp",
			packageRange: ACP_ADAPTER_PACKAGE_RANGES.pi,
			preferredBinName: "pi-acp"
		}
	},
	openclaw: {
		name: "OpenClaw",
		argv: ["openclaw", "acp"]
	},
	codex: {
		name: "Codex",
		argv: [
			"npx",
			"-y",
			`@agentclientprotocol/codex-acp@${ACP_ADAPTER_PACKAGE_RANGES.codex}`
		],
		installedArgv: ["codex-acp"],
		package: {
			packageName: "@agentclientprotocol/codex-acp",
			packageRange: ACP_ADAPTER_PACKAGE_RANGES.codex,
			preferredBinName: "codex-acp",
			legacyFallbackCommands: []
		},
		packageExecFallback: true
	},
	claude: {
		name: "Claude Code",
		argv: [
			"npx",
			"-y",
			`@agentclientprotocol/claude-agent-acp@${ACP_ADAPTER_PACKAGE_RANGES.claude}`
		],
		installedArgv: ["claude-agent-acp"],
		package: {
			packageName: "@agentclientprotocol/claude-agent-acp",
			packageRange: ACP_ADAPTER_PACKAGE_RANGES.claude,
			preferredBinName: "claude-agent-acp",
			legacyFallbackCommands: [`npm exec @agentclientprotocol/claude-agent-acp@${ACP_ADAPTER_PACKAGE_RANGES.claude}`]
		},
		packageExecFallback: true
	},
	gemini: {
		name: "Gemini CLI",
		argv: ["gemini", "--acp"]
	},
	cursor: {
		name: "Cursor",
		argv: ["cursor-agent", "acp"]
	},
	copilot: {
		name: "GitHub Copilot",
		argv: [
			"copilot",
			"--acp",
			"--stdio"
		]
	},
	antigravity: {
		name: "Google Antigravity",
		argv: process.platform === "win32" ? ["agy_acp_server.exe"] : ["agy_acp_server.par", ...process.platform === "linux" ? ["--uid="] : []]
	},
	devin: {
		name: "Devin",
		argv: ["devin", "acp"]
	},
	droid: {
		name: "Factory Droid",
		argv: [
			"droid",
			"exec",
			"--output-format",
			"acp"
		]
	},
	"fast-agent": {
		name: "Fast Agent",
		argv: [
			"uvx",
			"fast-agent-mcp",
			"acp"
		]
	},
	fx: {
		name: "fx",
		argv: ["fx", "acp"]
	},
	"grok-build": {
		name: "Grok Build",
		argv: [
			"grok",
			"agent",
			"stdio"
		]
	},
	iflow: {
		name: "iFlow",
		argv: ["iflow", "--experimental-acp"]
	},
	junie: {
		name: "Junie",
		argv: ["junie", "--acp=true"]
	},
	kilocode: {
		name: "Kilo Code",
		argv: [
			"npx",
			"-y",
			"@kilocode/cli",
			"acp"
		],
		installedArgv: ["kilo", "acp"]
	},
	kimi: {
		name: "Kimi Code",
		argv: ["kimi", "acp"]
	},
	kiro: {
		name: "Kiro",
		argv: ["kiro-cli-chat", "acp"]
	},
	mcode: {
		name: "MCode",
		argv: ["mcode", "acp"]
	},
	mux: {
		name: "Mux",
		argv: [
			"npx",
			"-y",
			`mux@${ACP_ADAPTER_PACKAGE_RANGES.mux}`,
			"acp"
		]
	},
	octomind: {
		name: "Octomind",
		argv: [
			"octomind",
			"acp",
			"developer:general"
		]
	},
	opencode: {
		name: "OpenCode",
		argv: [
			"npx",
			"-y",
			"opencode-ai",
			"acp"
		],
		installedArgv: ["opencode", "acp"]
	},
	pool: {
		name: "Poolside",
		argv: ["pool", "acp"]
	},
	qoder: {
		name: "Qoder",
		argv: ["qodercli", "--acp"]
	},
	qwen: {
		name: "Qwen Code",
		argv: ["qwen", "--acp"]
	},
	trae: {
		name: "Trae",
		argv: [
			"traecli",
			"acp",
			"serve"
		]
	},
	zeroclaw: {
		name: "ZeroClaw",
		argv: ["zeroclaw", "acp"]
	}
};
const AGENT_ARGV_REGISTRY = Object.fromEntries(Object.entries(AGENT_DEFINITIONS).map(([id, definition]) => [id, [...definition.argv]]));
const AGENT_REGISTRY = Object.fromEntries(Object.entries(AGENT_DEFINITIONS).map(([id, definition]) => [id, definition.argv.join(" ")]));
const BUILT_IN_AGENT_PACKAGES = Object.fromEntries(Object.entries(AGENT_DEFINITIONS).flatMap(([id, definition]) => definition.packageExecFallback && definition.package ? [[id, {
	...definition.package,
	fallbackCommand: definition.argv.join(" ")
}]] : []));
function isPackageExecution(argv) {
	const command = path.win32.basename(argv[0]).toLowerCase().replace(/\.(cmd|exe|bat)$/, "");
	if ([
		"npx",
		"uvx",
		"npm",
		"pnpm",
		"bunx"
	].includes(command)) return true;
	switch (command) {
		case "bun": return argv[1] === "x";
		case "uv": return argv[1] === "tool" && argv[2] === "run";
		case "node": return /(?:npm|npx)-cli\.js$/u.test(argv[1] ?? "");
		default: return false;
	}
}
function inspectionDefinition(id, override) {
	const definition = Object.hasOwn(AGENT_DEFINITIONS, id) ? AGENT_DEFINITIONS[id] : void 0;
	if (!override) return definition;
	let argv = override;
	if (typeof argv === "string") {
		const parsed = splitCommandLine(argv);
		argv = [parsed.command, ...parsed.args];
	}
	return {
		name: definition?.name ?? id,
		argv
	};
}
function inspectAgent(agentId, override, options = {}) {
	const id = resolveCanonicalAgentName(agentId);
	const definition = inspectionDefinition(id, override);
	if (!definition) return;
	const argv = definition.installedArgv ?? definition.argv;
	if (isPackageExecution(argv)) return;
	const launch = inspectLaunch(argv, definition.package ? {
		...definition.package,
		fallbackCommand: definition.argv.join(" ")
	} : void 0, options);
	return {
		id,
		name: definition.name,
		launch: inspectPrerequisites(launch, definition.requiredCommands ?? [], options)
	};
}
function inspectPrerequisites(launch, requiredCommands, options) {
	const resolveExecutable = options.resolveExecutable ?? resolveInstalledExecutable;
	const missingCommands = requiredCommands.filter((command) => !resolveExecutable(command)).map((name) => ({
		kind: "command",
		name
	}));
	if (missingCommands.length === 0) return launch;
	return {
		kind: "missing",
		requirements: [...launch.kind === "missing" ? launch.requirements : [], ...missingCommands]
	};
}
function inspectLaunch(argv, spec, options) {
	const command = (options.resolveExecutable ?? resolveInstalledExecutable)(argv[0]);
	if (command) return {
		kind: "installed",
		argv: [command, ...argv.slice(1)]
	};
	if (!spec) return {
		kind: "missing",
		requirements: [{
			kind: "command",
			name: argv[0]
		}]
	};
	const installed = resolveInstalledBuiltInAgentLaunchForSpec(spec, options);
	return installed ? {
		kind: "installed",
		argv: [installed.command, ...installed.args]
	} : {
		kind: "missing",
		requirements: [{
			kind: "package",
			name: spec.packageName
		}]
	};
}
const AGENT_ALIASES = {
	"factory-droid": "droid",
	factorydroid: "droid"
};
const DEFAULT_AGENT_NAME = "codex";
function normalizeAgentName(value) {
	return value.trim().toLowerCase();
}
function resolveCanonicalAgentName(value) {
	const normalized = normalizeAgentName(value);
	return Object.hasOwn(AGENT_ALIASES, normalized) ? AGENT_ALIASES[normalized] : normalized;
}
function findAgentEntry(registry, agentName) {
	const normalized = normalizeAgentName(agentName);
	const canonical = resolveCanonicalAgentName(agentName);
	return Object.hasOwn(registry, normalized) ? registry[normalized] : Object.hasOwn(registry, canonical) ? registry[canonical] : void 0;
}
function mergeAgentRegistry(overrides) {
	if (!overrides) return { ...AGENT_REGISTRY };
	const entries = Object.entries(AGENT_REGISTRY);
	for (const [name, command] of Object.entries(overrides)) {
		const normalized = normalizeAgentName(name);
		if (!normalized || !command.trim()) continue;
		entries.push([normalized, command.trim()]);
	}
	return Object.fromEntries(entries);
}
function resolveAgentCommand(agentName, overrides) {
	return findAgentEntry(mergeAgentRegistry(overrides), agentName) ?? agentName;
}
function resolveAgentArgv(agentName) {
	const argv = findAgentEntry(AGENT_ARGV_REGISTRY, agentName);
	return argv ? [...argv] : void 0;
}
function findBuiltInAgentPackage(agentCommand) {
	const normalized = agentCommand.trim();
	return Object.values(BUILT_IN_AGENT_PACKAGES).find((spec) => spec.fallbackCommand === normalized || spec.legacyFallbackCommands?.includes(normalized));
}
function defaultResolvePackageRoot(packageName) {
	const segments = packageName.split("/");
	let cursor = path.dirname(fileURLToPath(import.meta.url));
	while (true) {
		const candidateRoot = path.join(cursor, "node_modules", ...segments);
		const manifestPath = path.join(candidateRoot, "package.json");
		if (fs.existsSync(manifestPath)) try {
			if (JSON.parse(fs.readFileSync(manifestPath, "utf8")).name === packageName) return candidateRoot;
		} catch {}
		const parent = path.dirname(cursor);
		if (parent === cursor) throw new Error(`Built-in agent package not found: ${packageName}`);
		cursor = parent;
	}
}
function resolvePackageBin(spec, manifest) {
	if (typeof manifest.bin === "string") return manifest.bin;
	if (!manifest.bin || typeof manifest.bin !== "object") return;
	return manifest.bin[spec.preferredBinName] ?? (Object.keys(manifest.bin).length === 1 ? Object.values(manifest.bin)[0] : void 0);
}
function defaultResolveNpmCliPath(execPath) {
	const candidate = path.resolve(path.dirname(execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
	if (!fs.existsSync(candidate)) throw new Error(`npm CLI not found for execPath: ${execPath}`);
	return candidate;
}
function resolveInstalledBuiltInAgentLaunch(agentCommand, options = {}) {
	const spec = findBuiltInAgentPackage(agentCommand);
	if (!spec) return;
	return resolveInstalledBuiltInAgentLaunchForSpec(spec, options);
}
function resolveInstalledBuiltInAgentLaunchForSpec(spec, options) {
	const readFileSync = options.readFileSync ?? fs.readFileSync;
	const existsSync = options.existsSync ?? fs.existsSync;
	const resolvePackageRoot = options.resolvePackageRoot ?? defaultResolvePackageRoot;
	try {
		const resolved = resolveInstalledBuiltInAgentPackage(spec, {
			readFileSync,
			existsSync,
			resolvePackageRoot
		});
		if (!resolved) return;
		return {
			source: "installed",
			command: process.execPath,
			args: [resolved.binPath],
			packageName: spec.packageName,
			packageRange: spec.packageRange,
			packageVersion: resolved.packageVersion,
			binPath: resolved.binPath
		};
	} catch {
		return;
	}
}
function resolveInstalledBuiltInAgentPackage(spec, options) {
	const packageRoot = options.resolvePackageRoot(spec.packageName);
	if (!packageRoot) return;
	const manifest = JSON.parse(options.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
	if (manifest.name !== spec.packageName) return;
	const relativeBinPath = resolvePackageBin(spec, manifest);
	if (!relativeBinPath) return;
	const binPath = path.resolve(packageRoot, relativeBinPath);
	return options.existsSync(binPath) ? {
		packageVersion: manifest.version,
		binPath
	} : void 0;
}
function resolvePackageExecBuiltInAgentLaunch(agentCommand, options = {}) {
	const spec = findBuiltInAgentPackage(agentCommand);
	if (!spec) return;
	const existsSync = options.existsSync ?? fs.existsSync;
	const execPath = options.execPath ?? process.execPath;
	const resolveNpmCliPath = options.resolveNpmCliPath ?? defaultResolveNpmCliPath;
	try {
		const npmCliPath = resolveNpmCliPath(execPath);
		if (!existsSync(npmCliPath)) return;
		return {
			source: "package-exec",
			command: execPath,
			args: [
				npmCliPath,
				"exec",
				"--yes",
				`--package=${spec.packageName}@${spec.packageRange}`,
				"--",
				spec.preferredBinName
			],
			packageName: spec.packageName,
			packageRange: spec.packageRange,
			npmCliPath
		};
	} catch {
		return;
	}
}
function resolveBuiltInAgentLaunch(agentCommand, options = {}) {
	return resolveInstalledBuiltInAgentLaunch(agentCommand, options) ?? resolvePackageExecBuiltInAgentLaunch(agentCommand, options);
}
function listBuiltInAgents(overrides) {
	return [.../* @__PURE__ */ new Set([...Object.keys(AGENT_REGISTRY), ...Object.keys(overrides ?? {})])];
}
function createAgentRegistry(params) {
	const overrides = normalizeRegistryOverrides(params?.overrides);
	return {
		resolve(agentName) {
			return findAgentEntry(overrides, agentName) ?? resolveAgentArgv(agentName) ?? resolveAgentCommand(agentName);
		},
		list() {
			return listBuiltInAgents(overrides);
		},
		inspect(agentId) {
			return inspectAgent(agentId, findAgentEntry(overrides, agentId), params);
		}
	};
}
function normalizeRegistryOverrides(values) {
	const entries = [];
	for (const [name, value] of Object.entries(values ?? {})) {
		const normalizedName = normalizeAgentName(name);
		if (!normalizedName) continue;
		const normalizedValue = normalizeRegistryOverride(value);
		if (normalizedValue) entries.push([normalizedName, normalizedValue]);
	}
	return Object.fromEntries(entries);
}
function normalizeRegistryOverride(value) {
	if (typeof value === "string") return value.trim() || void 0;
	return value.length > 0 && value[0]?.length ? [...value] : void 0;
}
export { requireAgentStdio as A, PROCESS_HELPER_TIMEOUT_MS as C, isoNow as D, isChildProcessRunning as E, waitForChildExit as F, waitForSpawn as I, resolveAgentSessionCwd as M, runTimedExecFile as N, normalizeAgentCommandInput as O, splitCommandLine as P, PROCESS_HELPER_MAX_BUFFER_BYTES as S, basenameToken as T, buildSpawnCommandOptions as _, createAgentRegistry as a, readWindowsEnvValue as b, mergeAgentRegistry as c, resolveAgentCommand as d, resolveBuiltInAgentLaunch as f, buildAgentSpawnCommand as g, resolvePackageExecBuiltInAgentLaunch as h, DEFAULT_AGENT_NAME as i, resolveAgentCommandParts as j, renderArgvIdentity as k, normalizeAgentName as l, resolveInstalledBuiltInAgentLaunch as m, AGENT_REGISTRY as n, findBuiltInAgentPackage as o, resolveCanonicalAgentName as p, BUILT_IN_AGENT_PACKAGES as r, listBuiltInAgents as s, AGENT_ARGV_REGISTRY as t, resolveAgentArgv as u, buildTerminalShellSpawnCommand as v, asAbsoluteCwd as w, resolveWindowsExecutablePath as x, buildTerminalSpawnCommand as y };

//# sourceMappingURL=agent-registry-Cz9fD9H1.js.map