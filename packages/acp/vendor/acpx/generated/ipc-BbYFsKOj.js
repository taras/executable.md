import { C as PROCESS_HELPER_TIMEOUT_MS, E as isChildProcessRunning, N as runTimedExecFile, P as splitCommandLine, S as PROCESS_HELPER_MAX_BUFFER_BYTES, n as AGENT_REGISTRY, r as BUILT_IN_AGENT_PACKAGES, t as AGENT_ARGV_REGISTRY } from "./agent-registry-Cz9fD9H1.js";
import fs, { statSync } from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import os from "node:os";
import { statRegularFile, tempFile, withTempFile } from "@openclaw/fs-safe/advanced";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
import { root } from "@openclaw/fs-safe";
import { z } from "zod";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { isHardlinkFallbackError } from "@openclaw/fs-safe/durability";
import { acquireFileLock } from "@openclaw/fs-safe/file-lock";
import net from "node:net";
import { resolveSecureTempRoot } from "@openclaw/fs-safe/secure-temp-root";
// src/errors.ts
var AcpxOperationalError = class extends Error {
	outputCode;
	detailCode;
	origin;
	retryable;
	acp;
	outputAlreadyEmitted;
	constructor(message, options) {
		super(message, options);
		this.name = new.target.name;
		this.outputCode = options?.outputCode;
		this.detailCode = options?.detailCode;
		this.origin = options?.origin;
		this.retryable = options?.retryable;
		this.acp = options?.acp;
		this.outputAlreadyEmitted = options?.outputAlreadyEmitted;
	}
};
var SessionNotFoundError = class extends AcpxOperationalError {
	sessionId;
	constructor(sessionId) {
		super(`Session not found: ${sessionId}`);
		this.sessionId = sessionId;
	}
};
var SessionResolutionError = class extends AcpxOperationalError {};
var AgentSpawnError = class extends AcpxOperationalError {
	agentCommand;
	constructor(agentCommand, cause) {
		const spawnEnoent = (cause instanceof Error ? cause.code : void 0) === "ENOENT";
		const message = spawnEnoent ? `Failed to spawn agent command: ${agentCommand}. The agent process could not start because a required executable, interpreter, working directory, or other launch path was not found. Check the command, effective PATH, and working directory, or verify the custom agent's configured argv.` : `Failed to spawn agent command: ${agentCommand}`;
		super(message, {
			cause: cause instanceof Error ? cause : void 0,
			...spawnEnoent ? { detailCode: "AGENT_SPAWN_ENOENT" } : {}
		});
		this.agentCommand = agentCommand;
	}
};
var AgentStartupError = class extends AcpxOperationalError {
	agentCommand;
	exitCode;
	signal;
	stderrSummary;
	constructor(params) {
		const exitSummary = `exit=${params.exitCode ?? "null"}, signal=${params.signal ?? "null"}`;
		const stderrSuffix = typeof params.stderrSummary === "string" && params.stderrSummary.trim().length > 0 ? `: ${params.stderrSummary.trim()}` : "";
		super(`ACP agent exited before initialize completed (${exitSummary})${stderrSuffix}`, {
			cause: params.cause instanceof Error ? params.cause : void 0,
			outputCode: "RUNTIME",
			detailCode: "AGENT_STARTUP_FAILED",
			origin: "acp"
		});
		this.agentCommand = params.agentCommand;
		this.exitCode = params.exitCode;
		this.signal = params.signal;
		this.stderrSummary = params.stderrSummary?.trim() || void 0;
	}
};
var AgentDisconnectedError = class extends AcpxOperationalError {
	reason;
	exitCode;
	signal;
	constructor(reason, exitCode, signal, options) {
		super(`ACP agent disconnected during request (${reason}, exit=${exitCode ?? "null"}, signal=${signal ?? "null"})`, {
			outputCode: "RUNTIME",
			detailCode: "AGENT_DISCONNECTED",
			origin: "acp",
			...options
		});
		this.reason = reason;
		this.exitCode = exitCode;
		this.signal = signal;
	}
};
var UnsupportedPromptContentError = class extends AcpxOperationalError {
	constructor(message) {
		super(message, {
			outputCode: "USAGE",
			detailCode: "UNSUPPORTED_PROMPT_CONTENT",
			origin: "acp"
		});
	}
};
var SessionResumeRequiredError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "RUNTIME",
			detailCode: "SESSION_RESUME_REQUIRED",
			origin: "acp",
			retryable: true,
			...options
		});
	}
};
var GeminiAcpStartupTimeoutError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "TIMEOUT",
			detailCode: "GEMINI_ACP_STARTUP_TIMEOUT",
			origin: "acp",
			...options
		});
	}
};
var SessionModeReplayError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "RUNTIME",
			detailCode: "SESSION_MODE_REPLAY_FAILED",
			origin: "acp",
			...options
		});
	}
};
var SessionModelReplayError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "RUNTIME",
			detailCode: "SESSION_MODEL_REPLAY_FAILED",
			origin: "acp",
			...options
		});
	}
};
var SessionConfigOptionReplayError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "RUNTIME",
			detailCode: "SESSION_CONFIG_OPTION_REPLAY_FAILED",
			origin: "acp",
			...options
		});
	}
};
var ClaudeAcpSessionCreateTimeoutError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "TIMEOUT",
			detailCode: "CLAUDE_ACP_SESSION_CREATE_TIMEOUT",
			origin: "acp",
			...options
		});
	}
};
var CopilotAcpUnsupportedError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "RUNTIME",
			detailCode: "COPILOT_ACP_UNSUPPORTED",
			origin: "acp",
			...options
		});
	}
};
var AuthPolicyError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "RUNTIME",
			detailCode: "AUTH_REQUIRED",
			origin: "acp",
			...options
		});
	}
};
var QueueConnectionError = class extends AcpxOperationalError {};
var QueueProtocolError = class extends AcpxOperationalError {};
var PermissionDeniedError = class extends AcpxOperationalError {};
var PermissionPromptUnavailableError = class extends AcpxOperationalError {
	constructor(message = "Permission prompt unavailable in non-interactive mode") {
		super(message);
	}
};
// src/types.ts
const EXIT_CODES = {
	SUCCESS: 0,
	ERROR: 1,
	USAGE: 2,
	TIMEOUT: 3,
	NO_SESSION: 4,
	PERMISSION_DENIED: 5,
	INTERRUPTED: 130
};
const OUTPUT_FORMATS = [
	"text",
	"json",
	"quiet"
];
const PERMISSION_MODES = [
	"approve-all",
	"approve-reads",
	"deny-all"
];
const AUTH_POLICIES = ["skip", "fail"];
const NON_INTERACTIVE_PERMISSION_POLICIES = ["deny", "fail"];
const PERMISSION_POLICY_ACTIONS = [
	"approve",
	"deny",
	"escalate"
];
const OUTPUT_ERROR_CODES = [
	"NO_SESSION",
	"TIMEOUT",
	"PERMISSION_DENIED",
	"PERMISSION_PROMPT_UNAVAILABLE",
	"EXEC_DISABLED",
	"RUNTIME",
	"USAGE"
];
const OUTPUT_ERROR_ORIGINS = [
	"cli",
	"runtime",
	"queue",
	"acp"
];
const SESSION_RECORD_SCHEMA = "acpx.session.v1";
// src/acp/error-shapes.ts
const RESOURCE_NOT_FOUND_ACP_CODES = /* @__PURE__ */ new Set([-32001, -32002]);
function asRecord$5(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function toAcpErrorPayload(value) {
	const record = asRecord$5(value);
	if (!record) return;
	if (typeof record.code !== "number" || !Number.isFinite(record.code)) return;
	if (typeof record.message !== "string" || record.message.length === 0) return;
	return {
		code: record.code,
		message: record.message,
		data: record.data
	};
}
function extractAcpErrorInternal(value, depth) {
	if (depth > 5) return;
	const direct = toAcpErrorPayload(value);
	if (direct) return direct;
	const record = asRecord$5(value);
	if (!record) return;
	return extractNestedAcpError(record, depth);
}
function extractNestedAcpError(record, depth) {
	for (const key of [
		"error",
		"acp",
		"cause"
	]) if (key in record) {
		const nested = extractAcpErrorInternal(record[key], depth + 1);
		if (nested) return nested;
	}
}
function formatUnknownErrorMessage(error) {
	if (error instanceof Error) return error.message;
	if (error && typeof error === "object") {
		const maybeMessage = error.message;
		if (typeof maybeMessage === "string" && maybeMessage.length > 0) return maybeMessage;
		try {
			return JSON.stringify(error);
		} catch {}
	}
	return String(error);
}
const SESSION_NOT_FOUND_PATTERN = /session\s+["'\w-]+\s+not found/i;
function isSessionNotFoundText(value) {
	if (typeof value !== "string") return false;
	const normalized = value.toLowerCase();
	return normalized.includes("resource_not_found") || normalized.includes("resource not found") || normalized.includes("session not found") || normalized.includes("unknown session") || normalized.includes("invalid session identifier") || SESSION_NOT_FOUND_PATTERN.test(value);
}
function hasSessionNotFoundHint(value, depth = 0) {
	if (depth > 4) return false;
	if (isSessionNotFoundText(value)) return true;
	if (Array.isArray(value)) return value.some((entry) => hasSessionNotFoundHint(entry, depth + 1));
	const record = asRecord$5(value);
	if (!record) return false;
	return Object.values(record).some((entry) => hasSessionNotFoundHint(entry, depth + 1));
}
function extractAcpError(error) {
	return extractAcpErrorInternal(error, 0);
}
function isAcpResourceNotFoundError(error) {
	const acp = extractAcpError(error);
	if (acp && RESOURCE_NOT_FOUND_ACP_CODES.has(acp.code)) return true;
	if (acp) {
		if (isSessionNotFoundText(acp.message)) return true;
		if (hasSessionNotFoundHint(acp.data)) return true;
	}
	return isSessionNotFoundText(formatUnknownErrorMessage(error));
}
// src/acp/error-normalization.ts
const AUTH_REQUIRED_ACP_CODES = /* @__PURE__ */ new Set([-32e3]);
const QUERY_CLOSED_BEFORE_RESPONSE_DETAIL = "query closed before response received";
function asRecord$4(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function isAuthRequiredMessage(value) {
	if (!value) return false;
	const normalized = value.toLowerCase();
	return [
		"auth required",
		"authentication required",
		"authorization required",
		"credential required",
		"credentials required",
		"token required",
		"login required"
	].some((needle) => normalized.includes(needle));
}
function isAcpAuthRequiredPayload(acp) {
	if (!acp) return false;
	if (!AUTH_REQUIRED_ACP_CODES.has(acp.code)) return false;
	if (isAuthRequiredMessage(acp.message)) return true;
	const data = asRecord$4(acp.data);
	if (!data) return false;
	return hasAuthRequiredData(data);
}
function hasAuthRequiredData(data) {
	return data.authRequired === true || hasNonEmptyString(data.methodId) || hasNonEmptyArray(data.methods);
}
function hasNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}
function hasNonEmptyArray(value) {
	return Array.isArray(value) && value.length > 0;
}
function isOutputErrorCode$1(value) {
	return typeof value === "string" && OUTPUT_ERROR_CODES.includes(value);
}
function isOutputErrorOrigin$1(value) {
	return typeof value === "string" && OUTPUT_ERROR_ORIGINS.includes(value);
}
function readOutputErrorMeta(error) {
	const record = asRecord$4(error);
	if (!record) return {};
	return {
		outputCode: isOutputErrorCode$1(record.outputCode) ? record.outputCode : void 0,
		detailCode: typeof record.detailCode === "string" && record.detailCode.trim().length > 0 ? record.detailCode : void 0,
		origin: isOutputErrorOrigin$1(record.origin) ? record.origin : void 0,
		retryable: typeof record.retryable === "boolean" ? record.retryable : void 0,
		acp: extractAcpError(record.acp)
	};
}
function isTimeoutLike(error) {
	return error instanceof Error && error.name === "TimeoutError";
}
function isNoSessionLike(error) {
	return error instanceof Error && error.name === "NoSessionError";
}
function isUsageLike(error) {
	if (!(error instanceof Error)) return false;
	return error.name === "CommanderError" || error.name === "InvalidArgumentError" || asRecord$4(error)?.code === "commander.invalidArgument";
}
function formatErrorMessage(error) {
	return formatUnknownErrorMessage(error);
}
function isAcpQueryClosedBeforeResponseError(error) {
	const acp = extractAcpError(error);
	if (!acp || acp.code !== -32603) return false;
	const details = asRecord$4(acp.data)?.details;
	if (typeof details !== "string") return false;
	return details.toLowerCase().includes(QUERY_CLOSED_BEFORE_RESPONSE_DETAIL);
}
function mapErrorCode(error) {
	if (error instanceof PermissionPromptUnavailableError) return "PERMISSION_PROMPT_UNAVAILABLE";
	if (error instanceof PermissionDeniedError) return "PERMISSION_DENIED";
	if (isTimeoutLike(error)) return "TIMEOUT";
	if (isNoSessionLike(error) || isAcpResourceNotFoundError(error)) return "NO_SESSION";
	if (isUsageLike(error)) return "USAGE";
}
function normalizeOutputError(error, options = {}) {
	const meta = readOutputErrorMeta(error);
	const code = resolveOutputErrorCode(error, options, meta);
	const acp = options.acp ?? meta.acp ?? extractAcpError(error);
	return {
		code,
		message: formatErrorMessage(error),
		detailCode: resolveDetailCode(error, acp, options, meta),
		origin: meta.origin ?? options.origin,
		retryable: meta.retryable ?? options.retryable,
		acp
	};
}
function resolveOutputErrorCode(error, options, meta) {
	const code = meta.outputCode ?? mapErrorCode(error) ?? options.defaultCode ?? "RUNTIME";
	if (code === "RUNTIME" && isAcpResourceNotFoundError(error)) return "NO_SESSION";
	return code;
}
function resolveDetailCode(error, acp, options, meta) {
	return meta.detailCode ?? options.detailCode ?? (error instanceof AuthPolicyError || isAcpAuthRequiredPayload(acp) ? "AUTH_REQUIRED" : void 0);
}
/**
* Returns true when an error from `client.prompt()` looks transient and
* can reasonably be retried (e.g. model-API 400/500, network hiccups that
* surface as ACP internal errors).
*
* Errors that are definitively non-recoverable (auth, missing session,
* invalid params, timeout, permission) return false.
*/
function isRetryablePromptError(error) {
	if (isNonRetryablePromptError(error)) return false;
	const acp = extractAcpError(error);
	if (!acp) return false;
	return acp.code === -32603 || acp.code === -32700;
}
function isNonRetryablePromptError(error) {
	return error instanceof PermissionDeniedError || error instanceof PermissionPromptUnavailableError || isTimeoutLike(error) || isNoSessionLike(error) || isUsageLike(error);
}
function exitCodeForOutputErrorCode(code) {
	switch (code) {
		case "USAGE": return EXIT_CODES.USAGE;
		case "TIMEOUT": return EXIT_CODES.TIMEOUT;
		case "NO_SESSION": return EXIT_CODES.NO_SESSION;
		case "PERMISSION_DENIED":
		case "PERMISSION_PROMPT_UNAVAILABLE": return EXIT_CODES.PERMISSION_DENIED;
		default: return EXIT_CODES.ERROR;
	}
}
// src/process-liveness.ts
function isProcessAlive(pid) {
	if (!pid || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
function isProcessDefinitelyDead(pid) {
	if (!pid || !Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return error.code === "ESRCH";
	}
}
// \0@oxc-project+runtime@0.155.0/helpers/esm/usingCtx.js
function _usingCtx() {
	var r = "function" == typeof SuppressedError ? SuppressedError : function(r, e) {
		var n = Error();
		return n.name = "SuppressedError", n.error = r, n.suppressed = e, n;
	}, e = {}, n = [];
	function using(r, e) {
		if (null != e) {
			if (Object(e) !== e) throw new TypeError("using declarations can only be used with objects, functions, null, or undefined.");
			if (r) var o = e[Symbol.asyncDispose || Symbol["for"]("Symbol.asyncDispose")];
			if (void 0 === o && (o = e[Symbol.dispose || Symbol["for"]("Symbol.dispose")], r)) var t = o;
			if ("function" != typeof o) throw new TypeError("Object is not disposable.");
			t && (o = function o() {
				try {
					t.call(e);
				} catch (r) {
					return Promise.reject(r);
				}
			}), n.push({
				v: e,
				d: o,
				a: r
			});
		} else r && n.push({
			d: e,
			a: r
		});
		return e;
	}
	return {
		e,
		u: using.bind(null, !1),
		a: using.bind(null, !0),
		d: function d() {
			var o, t = this.e, s = 0;
			function next() {
				for (; o = n.pop();) try {
					if (!o.a && 1 === s) return s = 0, n.push(o), Promise.resolve().then(next);
					if (o.d) {
						var r = o.d.call(o.v);
						if (o.a) return s |= 2, Promise.resolve(r).then(next, err);
					} else s |= 1;
				} catch (r) {
					return err(r);
				}
				if (1 === s) return t !== e ? Promise.reject(t) : Promise.resolve();
				if (t !== e) throw t;
			}
			function err(n) {
				return t = t !== e ? new r(n, t) : n, next();
			}
			return next();
		}
	};
}
// src/state-files.ts
async function writePrivateFile(filePath, content, options = {}) {
	try {
		var _usingCtx$1 = _usingCtx();
		const privateDirectory = options.privateDirectory !== false;
		await fs$1.mkdir(path.dirname(filePath), {
			recursive: true,
			mode: privateDirectory ? 448 : void 0
		});
		const directory = await fs$1.realpath(path.dirname(filePath));
		if (privateDirectory && process.platform !== "win32") await fs$1.chmod(directory, 448);
		const temporary = _usingCtx$1.a(await tempFile({
			rootDir: directory,
			prefix: "acpx-write",
			fileName: "record.json"
		}));
		const handle = await fs$1.open(temporary.path, "wx", 384);
		try {
			await handle.writeFile(content, "utf8");
			await handle.chmod(384);
		} finally {
			await handle.close();
		}
		await fs$1.rename(temporary.path, path.join(directory, path.basename(filePath)));
	} catch (_) {
		_usingCtx$1.e = _;
	} finally {
		await _usingCtx$1.d();
	}
}
async function writePrivateJsonFile(filePath, value) {
	await writePrivateFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
// src/session/event-log.ts
const DEFAULT_EVENT_SEGMENT_MAX_BYTES = 67108864;
/** Upper bound stored for a newly imported journal. */
const MAX_EVENT_SEGMENTS = 1024;
function retainedEventMaxSegments(value) {
	if (!Number.isFinite(value) || value < 1) return 0;
	return Math.floor(value);
}
function boundedEventMaxSegments(value) {
	if (!Number.isFinite(value) || value < 1) return 0;
	return Math.min(Math.floor(value), MAX_EVENT_SEGMENTS);
}
function sessionBaseDir() {
	return path.join(os.homedir(), ".acpx", "sessions");
}
function safeSessionId(sessionId) {
	return encodeURIComponent(sessionId);
}
function sessionEventActivePath(sessionId) {
	return path.join(sessionBaseDir(), `${safeSessionId(sessionId)}.stream.ndjson`);
}
function sessionEventSegmentPath(sessionId, segment) {
	return path.join(sessionBaseDir(), `${safeSessionId(sessionId)}.stream.${segment}.ndjson`);
}
function sessionEventLockPath(sessionId) {
	return path.join(sessionBaseDir(), `${safeSessionId(sessionId)}.stream.lock`);
}
async function existingEventSegmentIndices(sessionId) {
	return (await sessionEventFiles(sessionId)).indices;
}
async function sessionEventFiles(sessionId) {
	const activeName = `${safeSessionId(sessionId)}.stream.ndjson`;
	const indices = [];
	let active = false;
	for (const name of await readSessionDirNames()) {
		if (name === activeName) {
			active = true;
			continue;
		}
		const index = eventSegmentIndex(sessionId, name);
		if (index !== void 0) indices.push(index);
	}
	return {
		indices,
		active
	};
}
async function readSessionDirNames() {
	try {
		return await fs$1.readdir(sessionBaseDir());
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
}
function eventSegmentIndex(sessionId, name) {
	const prefix = `${safeSessionId(sessionId)}.stream.`;
	if (!name.startsWith(prefix) || !name.endsWith(".ndjson")) return;
	const middle = name.slice(prefix.length, -7);
	if (!/^[1-9]\d*$/.test(middle)) return;
	const index = Number(middle);
	return Number.isSafeInteger(index) ? index : void 0;
}
function defaultSessionEventLog(sessionId) {
	return {
		active_path: sessionEventActivePath(sessionId),
		segment_count: 5,
		max_segment_bytes: DEFAULT_EVENT_SEGMENT_MAX_BYTES,
		max_segments: 5,
		last_write_at: void 0,
		last_write_error: null
	};
}
// src/acp/jsonrpc.ts
function asRecord$3(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value;
}
function isAcpMessageObject(value) {
	return asRecord$3(value) !== null;
}
function hasValidId(value) {
	return value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value);
}
function isErrorObject(value) {
	const record = asRecord$3(value);
	return !!record && typeof record.code === "number" && Number.isFinite(record.code) && typeof record.message === "string";
}
function hasResultOrError(value) {
	const hasResult = Object.hasOwn(value, "result");
	const hasError = Object.hasOwn(value, "error");
	if (hasResult && hasError) return false;
	if (!hasResult && !hasError) return false;
	if (hasError && !isErrorObject(value.error)) return false;
	return true;
}
function hasMethod(value) {
	return typeof value.method === "string" && value.method.length > 0;
}
function isJsonRpcRequest(value) {
	return hasMethod(value) && Object.hasOwn(value, "id") && hasValidId(value.id);
}
function isJsonRpcNotificationRecord(value) {
	return hasMethod(value) && !Object.hasOwn(value, "id");
}
function isJsonRpcResponse(value) {
	if (hasMethod(value) || !Object.hasOwn(value, "id") || !hasValidId(value.id)) return false;
	return hasResultOrError(value);
}
function isAcpJsonRpcMessage(value) {
	const record = asRecord$3(value);
	if (!record || record.jsonrpc !== "2.0") return false;
	return isJsonRpcNotificationRecord(record) || isJsonRpcRequest(record) || isJsonRpcResponse(record);
}
function isJsonRpcNotification(message) {
	return Object.hasOwn(message, "method") && typeof message.method === "string" && !Object.hasOwn(message, "id");
}
function isSessionUpdateNotification(message) {
	return isJsonRpcNotification(message) && message.method === "session/update";
}
function sessionUpdateHasRequiredFields(update) {
	const kind = update.sessionUpdate;
	if (typeof kind !== "string") return false;
	if (kind === "agent_message_chunk" || kind === "agent_thought_chunk" || kind === "user_message_chunk") return isChunkContent(update.content);
	if (kind === "plan") return Array.isArray(update.entries) && update.entries.every(isPlanEntry);
	return true;
}
function isChunkContent(value) {
	const content = asRecord$3(value);
	return content !== null && typeof content.type === "string" && (content.type !== "text" || typeof content.text === "string");
}
function isPlanEntry(value) {
	const entry = asRecord$3(value);
	return entry !== null && typeof entry.status === "string" && typeof entry.content === "string";
}
function extractSessionUpdateNotification(message) {
	if (!isSessionUpdateNotification(message)) return;
	const params = asRecord$3(message.params);
	if (!params) return;
	const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
	if (!sessionId) return;
	const update = asRecord$3(params.update);
	if (!update || !sessionUpdateHasRequiredFields(update)) return;
	return {
		sessionId,
		update
	};
}
function parsePromptStopReason(message) {
	if (!Object.hasOwn(message, "id") || !Object.hasOwn(message, "result")) return;
	const record = asRecord$3(message.result);
	if (!record) return;
	return typeof record.stopReason === "string" ? record.stopReason : void 0;
}
function parsePermissionNotice(message) {
	if (!Object.hasOwn(message, "id") || !Object.hasOwn(message, "result")) return;
	const notice = asRecord$3(asRecord$3(asRecord$3(message.result)?._meta)?.acpx)?.permissionNotice;
	return typeof notice === "string" ? notice : void 0;
}
function parseJsonRpcErrorMessage(message) {
	if (!Object.hasOwn(message, "error")) return;
	const errorRecord = asRecord$3(message.error);
	if (!errorRecord || typeof errorRecord.message !== "string") return;
	return errorRecord.message;
}
// src/perf-metrics.ts
const counters = /* @__PURE__ */ new Map();
const gauges = /* @__PURE__ */ new Map();
const timings = /* @__PURE__ */ new Map();
function hrNow() {
	return process.hrtime.bigint();
}
function durationMs(start) {
	return Number(process.hrtime.bigint() - start) / 1e6;
}
function roundMetric(value) {
	return Number(value.toFixed(3));
}
function incrementPerfCounter(name, delta = 1) {
	counters.set(name, (counters.get(name) ?? 0) + delta);
}
function setPerfGauge(name, value) {
	gauges.set(name, value);
}
function recordPerfDuration(name, durationMsValue) {
	const next = timings.get(name) ?? {
		count: 0,
		totalMs: 0,
		maxMs: 0
	};
	next.count += 1;
	next.totalMs += durationMsValue;
	next.maxMs = Math.max(next.maxMs, durationMsValue);
	timings.set(name, next);
}
async function measurePerf(name, run) {
	const startedAt = hrNow();
	try {
		return await run();
	} finally {
		recordPerfDuration(name, durationMs(startedAt));
	}
}
function startPerfTimer(name) {
	const startedAt = hrNow();
	return () => {
		const elapsedMs = durationMs(startedAt);
		recordPerfDuration(name, elapsedMs);
		return elapsedMs;
	};
}
function getPerfMetricsSnapshot() {
	return {
		counters: Object.fromEntries(counters.entries()),
		gauges: Object.fromEntries(gauges.entries()),
		timings: Object.fromEntries([...timings.entries()].map(([name, bucket]) => [name, {
			count: bucket.count,
			totalMs: roundMetric(bucket.totalMs),
			maxMs: roundMetric(bucket.maxMs)
		}]))
	};
}
function resetPerfMetrics() {
	counters.clear();
	gauges.clear();
	timings.clear();
}
function formatPerfMetric(name, durationMsValue) {
	return `${name}=${roundMetric(durationMsValue)}ms`;
}
// src/session/journal.ts
const SESSION_JOURNAL_SCHEMA = "acpx.session.journal.v1";
const sequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const resultSchema = z.union([z.object({
	status: z.enum(["completed", "cancelled"]),
	stopReason: z.string().optional(),
	_meta: z.record(z.string(), z.unknown()).nullable().optional()
}), z.object({
	status: z.literal("failed"),
	error: z.object({
		message: z.string(),
		code: z.string().optional(),
		detailCode: z.string().optional(),
		retryable: z.boolean().optional()
	})
})]);
const markerSchema = z.discriminatedUnion("type", [
	z.object({
		schema: z.literal(SESSION_JOURNAL_SCHEMA),
		type: z.literal("segment"),
		record_id: z.string(),
		sequence: sequenceSchema,
		message_sequence: sequenceSchema,
		request_id: z.string().nullable()
	}),
	z.object({
		schema: z.literal(SESSION_JOURNAL_SCHEMA),
		type: z.literal("turn_started"),
		request_id: z.string().min(1)
	}),
	z.object({
		schema: z.literal(SESSION_JOURNAL_SCHEMA),
		type: z.literal("turn_result"),
		request_id: z.string().min(1),
		result: resultSchema
	})
]);
const WATCH_PAGE_BYTES = 1048576;
function createJournalPage(options = {}) {
	const maxBytes = options.maxBytes ?? Infinity;
	if (!(maxBytes > 0)) throw new Error("Session journal page size must be positive");
	return {
		events: [],
		after: options.after ?? -1,
		bytes: 0,
		maxBytes
	};
}
function pageFull(page) {
	return page !== void 0 && page.bytes >= page.maxBytes;
}
function eventSink(page, sequence, bytes) {
	if (!page || sequence <= page.after) return;
	page.bytes += bytes;
	return page.events;
}
var SessionWatchError = class extends AcpxOperationalError {
	code;
	constructor(code, message) {
		super(message, {
			outputCode: code.startsWith("WATCH_CURSOR_") ? "USAGE" : "RUNTIME",
			detailCode: code,
			origin: "runtime",
			retryable: false
		});
		this.code = code;
	}
};
function corrupt(message) {
	throw new SessionWatchError("WATCH_JOURNAL_CORRUPT", message);
}
function sessionWatchCursor(recordId, sequence) {
	return Buffer.from(JSON.stringify([recordId, sequence])).toString("base64url");
}
function parseCursor(recordId, cursor) {
	let value;
	try {
		value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
	} catch {
		throw new SessionWatchError("WATCH_CURSOR_INVALID", "Invalid session watch cursor");
	}
	const parsed = z.tuple([z.string(), sequenceSchema]).safeParse(value);
	if (!parsed.success || sessionWatchCursor(...parsed.data) !== cursor) throw new SessionWatchError("WATCH_CURSOR_INVALID", "Invalid session watch cursor");
	if (parsed.data[0] !== recordId) throw new SessionWatchError("WATCH_CURSOR_FOREIGN", "Cursor belongs to another session");
	return parsed.data[1];
}
function fileIdentity(stat) {
	return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}
async function pathIdentity(filePath) {
	try {
		return fileIdentity(await fs$1.lstat(filePath, { bigint: true }));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
}
function boundedJournalPaths(sessionId, saved) {
	const paths = [];
	for (let index = saved; index > 0; index -= 1) paths.push(sessionEventSegmentPath(sessionId, index));
	paths.push(sessionEventActivePath(sessionId));
	return paths;
}
function sparseRotationHoles(indices, present, saved) {
	const holes = [];
	if (!present.has(1)) holes.push(1);
	for (const index of indices) {
		const next = index + 1;
		if (index < saved && next <= saved && !present.has(next)) holes.push(next);
	}
	return holes;
}
function emptySegment() {
	return {
		offset: 0,
		pending: Buffer.alloc(0),
		sequence: 0,
		messageSequence: 0,
		requestId: null
	};
}
function retryableSnapshotError(error) {
	return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "not-found" || error.code === "path-mismatch");
}
var SessionJournalReader = class {
	record;
	states = /* @__PURE__ */ new Map();
	constructor(record) {
		this.record = record;
	}
	async discoverPaths() {
		const saved = retainedEventMaxSegments(this.record.eventLog.max_segments);
		if (saved > 1024) return await this.discoverSparsePaths(saved);
		return { paths: boundedJournalPaths(this.record.acpxRecordId, saved) };
	}
	async discoverSparsePaths(saved) {
		const id = this.record.acpxRecordId;
		const files = await sessionEventFiles(id);
		const indices = files.indices.filter((index) => index <= saved);
		const holeIndices = sparseRotationHoles(indices, new Set(indices), saved);
		const paths = [.../* @__PURE__ */ new Set([...indices, ...holeIndices])].toSorted((left, right) => right - left).map((index) => sessionEventSegmentPath(id, index));
		const active = sessionEventActivePath(id);
		paths.push(active);
		const holes = new Set(holeIndices.map((index) => sessionEventSegmentPath(id, index)));
		if (!files.active) holes.add(active);
		return {
			paths,
			holes
		};
	}
	async openSnapshot(signal) {
		for (;;) {
			signal?.throwIfAborted();
			const segments = [];
			try {
				const scan = await this.discoverPaths();
				const paths = await this.openPresentSegments(segments, scan.paths);
				if (await this.matchesSnapshot(paths, segments, scan.holes)) return segments;
			} catch (error) {
				if (!retryableSnapshotError(error)) {
					await this.closeSnapshot(segments);
					throw error;
				}
			}
			await this.closeSnapshot(segments);
			await setTimeout$1(5, void 0, { signal });
		}
	}
	async openPresentSegments(segments, paths) {
		const present = await Promise.all(paths.map((filePath) => statRegularFile(filePath)));
		if (present.every((entry) => entry.missing)) return paths;
		const directory = await root(path.dirname(paths[0]));
		const results = await Promise.allSettled(paths.filter((_, index) => !present[index].missing).map(async (filePath) => {
			const opened = await directory.open(path.basename(filePath), { symlinks: "reject" });
			try {
				return {
					filePath,
					opened,
					identity: fileIdentity(await opened.handle.stat({ bigint: true }))
				};
			} catch (error) {
				await opened[Symbol.asyncDispose]();
				throw error;
			}
		}));
		let failure;
		for (const result of results) if (result.status === "fulfilled") segments.push(result.value);
		else failure ??= result.reason;
		if (failure) throw failure;
		return paths;
	}
	async closeSnapshot(segments) {
		await Promise.all(segments.map(({ opened }) => opened[Symbol.asyncDispose]()));
	}
	async matchesSnapshot(paths, segments, holes) {
		const current = await Promise.all(paths.map(pathIdentity));
		const identities = new Map(segments.map((entry) => [entry.filePath, entry.identity]));
		return paths.every((filePath, index) => {
			const expected = identities.get(filePath);
			if (current[index] !== expected) return false;
			return holes === void 0 || expected !== void 0 || holes.has(filePath);
		});
	}
	async withSnapshot(read, signal) {
		for (;;) {
			const segments = await this.openSnapshot(signal);
			try {
				const outcome = await read(segments).then((value) => ({ value }), (error) => {
					if (!(error instanceof SessionWatchError) || error.code !== "WATCH_JOURNAL_CORRUPT") throw error;
					return { error };
				});
				const scan = await this.discoverPaths();
				if (await this.matchesSnapshot(scan.paths, segments, scan.holes)) {
					signal?.throwIfAborted();
					if ("error" in outcome) throw outcome.error;
					return outcome.value;
				}
			} finally {
				await this.closeSnapshot(segments);
			}
			await setTimeout$1(5, void 0, { signal });
		}
	}
	async readAcpMessages() {
		return await this.withSnapshot(async (segments) => {
			const messages = [];
			for (const { opened } of segments) {
				const payload = await opened.handle.readFile("utf8");
				for (const line of payload.split("\n")) try {
					const value = JSON.parse(line);
					if (isAcpJsonRpcMessage(value)) messages.push(value);
				} catch {}
			}
			return messages;
		});
	}
	async readTail() {
		return await this.withSnapshot(async (segments) => {
			let tail = emptySegment();
			let active = emptySegment();
			for (const segment of segments.toReversed()) {
				const state = emptySegment();
				await this.readSegment(segment.opened.handle, segment.opened.stat.size, state, void 0);
				if (segment.filePath === sessionEventActivePath(this.record.acpxRecordId)) active = state;
				if (state.firstSequence !== void 0) {
					tail = state;
					break;
				}
			}
			return {
				sequence: tail.sequence,
				messageSequence: tail.firstSequence === void 0 ? void 0 : tail.messageSequence,
				requestId: tail.requestId,
				activeSize: active.offset,
				activeAnchored: active.firstSequence !== void 0,
				activePartial: active.pending.length > 0
			};
		});
	}
	async read(signal, options) {
		const { result, states } = await this.withSnapshot(async (segments) => {
			const page = createJournalPage(options);
			const states = new Map(this.states);
			let hasMore = false;
			let firstSequence;
			let tail = emptySegment();
			let active = emptySegment();
			for (const segment of segments) {
				const state = { ...states.get(segment.identity) ?? emptySegment() };
				await this.readSegment(segment.opened.handle, segment.opened.stat.size, state, page, signal);
				states.set(segment.identity, state);
				if (state.firstSequence !== void 0) {
					if (firstSequence === void 0) firstSequence = state.firstSequence;
					else if (state.firstSequence !== tail.sequence) corrupt("Session journal segments are not contiguous");
					tail = state;
				}
				if (segment.filePath === sessionEventActivePath(this.record.acpxRecordId)) active = state;
				if (pageFull(page)) {
					hasMore = true;
					break;
				}
			}
			this.pruneStates(states, segments);
			return {
				states,
				result: {
					events: page.events,
					hasMore,
					firstSequence,
					sequence: tail.sequence,
					messageSequence: tail.messageSequence,
					requestId: tail.requestId,
					activeSize: active.offset,
					activeAnchored: active.firstSequence !== void 0,
					activePartial: active.pending.length > 0
				}
			};
		}, signal);
		signal?.throwIfAborted();
		this.states = states;
		return result;
	}
	pruneStates(states, segments) {
		const retained = new Set(segments.map((entry) => entry.identity));
		for (const identity of states.keys()) if (!retained.has(identity)) states.delete(identity);
	}
	async readSegment(handle, size, state, page, signal) {
		if (size < state.offset) corrupt("Session journal was truncated while watching");
		const buffer = Buffer.alloc(Math.min(65536, size - state.offset));
		for (;;) {
			signal?.throwIfAborted();
			this.consumePending(state, page);
			if (pageFull(page) || state.offset >= size) return;
			const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - state.offset), state.offset);
			if (bytesRead === 0) corrupt("Session journal changed while reading");
			state.offset += bytesRead;
			state.pending = Buffer.concat([state.pending, buffer.subarray(0, bytesRead)]);
		}
	}
	consumePending(state, page) {
		const pending = state.pending;
		let start = 0;
		for (let end = pending.indexOf(10); end >= 0; end = pending.indexOf(10, start)) {
			this.consumeLine(pending.subarray(start, end).toString("utf8"), state, page, end - start + 1);
			start = end + 1;
			if (pageFull(page)) break;
		}
		state.pending = Buffer.from(pending.subarray(start));
	}
	consumeLine(line, state, page, bytes) {
		const entry = decodeJournalLine(line, state.firstSequence !== void 0);
		if (!entry) return;
		if (entry.type === "marker") {
			this.consumeMarker(entry.marker, state, page, bytes);
			return;
		}
		if (state.firstSequence === void 0) return;
		this.advance(state);
		state.messageSequence += 1;
		eventSink(page, state.sequence, bytes)?.push({
			...this.eventPosition(state),
			type: "message",
			requestId: state.requestId,
			message: entry.message
		});
	}
	advance(state) {
		state.sequence += 1;
		if (!Number.isSafeInteger(state.sequence)) corrupt("Session journal sequence exceeds its supported range");
	}
	eventPosition(state) {
		return {
			sequence: state.sequence,
			cursor: sessionWatchCursor(this.record.acpxRecordId, state.sequence)
		};
	}
	consumeMarker(marker, state, page, bytes) {
		if (marker.type === "segment") {
			this.acceptAnchor(marker, state);
			return;
		}
		if (state.firstSequence === void 0) corrupt("Session journal lifecycle record has no segment anchor");
		this.advance(state);
		if (marker.type === "turn_started") {
			state.requestId = marker.request_id;
			eventSink(page, state.sequence, bytes)?.push({
				...this.eventPosition(state),
				type: "turn_started",
				requestId: state.requestId
			});
		} else {
			if (state.requestId !== marker.request_id) corrupt("Session journal result does not match the active request");
			eventSink(page, state.sequence, bytes)?.push({
				...this.eventPosition(state),
				type: "turn_result",
				requestId: state.requestId,
				result: marker.result
			});
			state.requestId = null;
		}
	}
	acceptAnchor(anchor, state) {
		if (state.firstSequence !== void 0 || anchor.record_id !== this.record.acpxRecordId) corrupt("Invalid session journal segment anchor");
		state.firstSequence = anchor.sequence;
		state.sequence = anchor.sequence;
		state.messageSequence = anchor.message_sequence;
		state.requestId = anchor.request_id;
	}
};
function decodeJournalLine(line, anchored) {
	let value;
	try {
		value = JSON.parse(line);
	} catch {
		if (anchored) corrupt("Invalid complete line in session journal");
		return;
	}
	if (isAcpJsonRpcMessage(value)) return {
		type: "message",
		message: value
	};
	const marker = markerSchema.safeParse(value);
	if (marker.success) return {
		type: "marker",
		marker: marker.data
	};
	if (anchored || hasJournalSchema(value)) corrupt("Invalid record in session journal");
}
function hasJournalSchema(value) {
	return value !== null && typeof value === "object" && "schema" in value;
}
function watchSession(options) {
	return { [Symbol.asyncIterator]() {
		const stopped = new AbortController();
		const signal = options.signal ? AbortSignal.any([options.signal, stopped.signal]) : stopped.signal;
		const iterator = iterateSession({
			...options,
			signal
		});
		return {
			next: () => iterator.next(),
			return: async () => {
				stopped.abort();
				return await iterator.return();
			}
		};
	} };
}
async function* iterateSession(options) {
	const { signal } = options;
	if (signal.aborted) return;
	const record = await settleUnlessAborted(Promise.resolve(options.record), signal);
	if (!record) return;
	yield* iterateJournal(record, options);
}
async function* iterateJournal(record, options) {
	const { signal } = options;
	let after = options.cursor === void 0 ? -1 : parseCursor(record.acpxRecordId, options.cursor);
	const reader = new SessionJournalReader(record);
	let first = true;
	const observation = {};
	for (;;) {
		if (signal.aborted) return;
		const snapshot = await settleUnlessAborted(reader.read(signal, {
			after,
			maxBytes: WATCH_PAGE_BYTES
		}), signal);
		if (!snapshot) return;
		assertRetainedCursor(after, snapshot, first);
		first = false;
		for (const { sequence, ...event } of snapshot.events) {
			if (signal.aborted) return;
			after = sequence;
			yield event;
		}
		if (!await continueAfterPage(record, snapshot, options, observation)) return;
	}
}
async function continueAfterPage(record, snapshot, options, observation) {
	if (options.signal.aborted || confirmsTerminalObservation(snapshot, observation)) return false;
	if (!snapshot.hasMore && options.continueWatching) {
		const decision = await settleUnlessAborted(options.continueWatching(record, snapshot.requestId), options.signal).catch((error) => {
			if (error instanceof SessionWatchError && error.code === "WATCH_OUTCOME_UNKNOWN") return error;
			throw error;
		});
		if (decision !== true) {
			observation.terminal = {
				requestId: snapshot.requestId,
				error: decision instanceof SessionWatchError ? decision : void 0
			};
			return !options.signal.aborted;
		}
	}
	await settleUnlessAborted(setTimeout$1(snapshot.hasMore ? 0 : 100, void 0, { signal: options.signal }), options.signal);
	return !options.signal.aborted;
}
function confirmsTerminalObservation(snapshot, observation) {
	const terminal = observation.terminal;
	delete observation.terminal;
	if (!terminal || snapshot.events.length > 0 || snapshot.hasMore || snapshot.requestId !== terminal.requestId) return false;
	if (terminal.error) throw terminal.error;
	return true;
}
function assertRetainedCursor(after, snapshot, first) {
	if (after < 0) return;
	if (after > snapshot.sequence) throw new SessionWatchError(first ? "WATCH_CURSOR_FUTURE" : "WATCH_CURSOR_EXPIRED", "Cursor is beyond the available session journal");
	if (snapshot.firstSequence !== void 0 && after < snapshot.firstSequence) throw new SessionWatchError("WATCH_CURSOR_EXPIRED", "Cursor is older than retained session history");
}
async function settleUnlessAborted(operation, signal) {
	try {
		return await operation;
	} catch (error) {
		if (signal?.aborted) return;
		throw error;
	}
}
// src/acp/agent-session-id.ts
const AGENT_SESSION_ID_META_KEYS = ["agentSessionId", "sessionId"];
function normalizeAgentSessionId(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function asMetaRecord(meta) {
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return;
	return meta;
}
function extractAgentSessionId(meta) {
	const record = asMetaRecord(meta);
	if (!record) return;
	for (const key of AGENT_SESSION_ID_META_KEYS) {
		const normalized = normalizeAgentSessionId(record[key]);
		if (normalized) return normalized;
	}
}
// src/session/persistence/serialize.ts
function serializeSessionRecordForDisk(record) {
	return {
		schema: SESSION_RECORD_SCHEMA,
		acpx_record_id: record.acpxRecordId,
		acp_session_id: record.acpSessionId,
		agent_session_id: normalizeAgentSessionId(record.agentSessionId),
		agent_command: record.agentCommand,
		agent_argv: record.agentArgv,
		cwd: record.cwd,
		name: record.name,
		created_at: record.createdAt,
		last_used_at: record.lastUsedAt,
		last_seq: record.lastSeq,
		last_request_id: record.lastRequestId,
		event_log: record.eventLog,
		closed: record.closed,
		closed_at: record.closedAt,
		pid: record.pid,
		agent_started_at: record.agentStartedAt,
		last_prompt_at: record.lastPromptAt,
		last_agent_exit_code: record.lastAgentExitCode,
		last_agent_exit_signal: record.lastAgentExitSignal,
		last_agent_exit_at: record.lastAgentExitAt,
		last_agent_disconnect_reason: record.lastAgentDisconnectReason,
		protocol_version: record.protocolVersion,
		agent_capabilities: record.agentCapabilities,
		title: record.title,
		messages: record.messages,
		updated_at: record.updated_at,
		cumulative_token_usage: record.cumulative_token_usage,
		cumulative_cost: record.cumulative_cost,
		request_token_usage: record.request_token_usage,
		acpx: record.acpx,
		session_materialization: record.sessionMaterialization,
		imported_from: record.importedFrom ? {
			record_id: record.importedFrom.recordId,
			cwd_original: record.importedFrom.cwdOriginal,
			exported_by: record.importedFrom.exportedBy,
			exported_at: record.importedFrom.exportedAt
		} : void 0
	};
}
// src/acp/builtin-command-migration.ts
const LEGACY_AGENT_COMMANDS = {
	pi: [
		"npx pi-acp",
		"npx pi-acp@^0.0.22",
		"npx pi-acp@^0.0.26",
		"npx pi-acp@^0.0.31"
	],
	codex: [
		"npx @zed-industries/codex-acp",
		"npx @zed-industries/codex-acp@^0.9.5",
		"npx @zed-industries/codex-acp@^0.10.0",
		"npx @zed-industries/codex-acp@^0.11.1",
		"npx @zed-industries/codex-acp@^0.12.0",
		"npx -y @agentclientprotocol/codex-acp@^0.0.44",
		"npx -y @agentclientprotocol/codex-acp@^1.1.4"
	],
	claude: [
		"npx @zed-industries/claude-agent-acp",
		"npx -y @zed-industries/claude-agent-acp",
		"npx -y @zed-industries/claude-agent-acp@^0.21.0",
		"npx -y @zed-industries/claude-agent-acp@^0.23.1",
		"npx -y @zed-industries/claude-agent-acp@^0.24.2",
		"npx -y @zed-industries/claude-agent-acp@^0.25.0",
		"npx -y @zed-industries/claude-agent-acp@^0.31.0",
		"npx -y @agentclientprotocol/claude-agent-acp@^0.24.2",
		"npx -y @agentclientprotocol/claude-agent-acp@^0.25.0",
		"npx -y @agentclientprotocol/claude-agent-acp@^0.31.0",
		"npx -y @agentclientprotocol/claude-agent-acp@^0.36.1",
		"npx -y @agentclientprotocol/claude-agent-acp@^0.37.0",
		"npx -y @agentclientprotocol/claude-agent-acp@^0.60.0",
		"npx -y @agentclientprotocol/claude-agent-acp@^0.76.0",
		"npx -y @agentclientprotocol/claude-agent-acp@^0.81.2",
		"npm exec @agentclientprotocol/claude-agent-acp@^0.25.0",
		"npm exec @agentclientprotocol/claude-agent-acp@^0.31.0",
		"npm exec @agentclientprotocol/claude-agent-acp@^0.36.1",
		"npm exec @agentclientprotocol/claude-agent-acp@^0.37.0",
		"npm exec @agentclientprotocol/claude-agent-acp@^0.60.0",
		"npm exec @agentclientprotocol/claude-agent-acp@^0.76.0",
		"npm exec @agentclientprotocol/claude-agent-acp@^0.81.2"
	],
	gemini: ["gemini", "gemini --experimental-acp"],
	kiro: ["kiro-cli acp"],
	mux: ["npx -y mux@^0.27.0 acp"],
	opencode: ["npx opencode-ai"]
};
function currentArgv(name) {
	const argv = AGENT_ARGV_REGISTRY[name];
	return argv ? [...argv] : void 0;
}
function isFallbackCommand(name, agentCommand) {
	return (BUILT_IN_AGENT_PACKAGES[name]?.legacyFallbackCommands ?? []).includes(agentCommand);
}
/** Built-in agent whose current or earlier default command is exactly `agentCommand`. */
function builtInAgentForCommand(agentCommand) {
	return Object.keys(AGENT_REGISTRY).find((name) => AGENT_REGISTRY[name] === agentCommand) ?? Object.keys(BUILT_IN_AGENT_PACKAGES).find((name) => isFallbackCommand(name, agentCommand)) ?? Object.keys(LEGACY_AGENT_COMMANDS).find((name) => LEGACY_AGENT_COMMANDS[name].includes(agentCommand));
}
function resolveAgentArgvForCommand(agentCommand) {
	const name = builtInAgentForCommand(agentCommand);
	return name ? currentArgv(name) : void 0;
}
function commandArgv(agentCommand) {
	const { command, args } = splitCommandLine(agentCommand);
	return [command, ...args];
}
function sameArgv(left, right) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
function launchesBuiltIn(agentCommand, agentArgv, name) {
	return agentArgv === void 0 || sameArgv(agentArgv, commandArgv(agentCommand)) || sameArgv(agentArgv, AGENT_ARGV_REGISTRY[name] ?? []);
}
/**
* Maps a saved launch identity from an earlier built-in default onto the current
* built-in command and argv, so agent-scoped lookup keeps finding the session
* after an adapter range change. Identities with a custom argv, and commands
* acpx never shipped as a built-in default, are returned unchanged.
*/
function migrateBuiltInAgentIdentity(agentCommand, agentArgv) {
	const name = builtInAgentForCommand(agentCommand);
	const current = name ? AGENT_REGISTRY[name] : void 0;
	if (!name || !current || current === agentCommand) return {
		agentCommand,
		agentArgv
	};
	if (!launchesBuiltIn(agentCommand, agentArgv, name)) return {
		agentCommand,
		agentArgv
	};
	return {
		agentCommand: current,
		agentArgv: currentArgv(name)
	};
}
/** The agent command a session saved under `agentCommand` is filed under after migration. */
function canonicalAgentCommand(agentCommand) {
	return migrateBuiltInAgentIdentity(agentCommand).agentCommand;
}
// src/session/persistence/parse.ts
function asRecord$2(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function hasOwn(source, key) {
	return Object.prototype.hasOwnProperty.call(source, key);
}
function isStringArray(value) {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
function parseOptionalAgentArgv(value) {
	return isStringArray(value) && value.length > 0 && value[0]?.length > 0 ? value : void 0;
}
function parsePersistedAgentIdentity(agentCommand, rawArgv) {
	const identity = migrateBuiltInAgentIdentity(agentCommand, parseOptionalAgentArgv(rawArgv));
	return {
		agentCommand: identity.agentCommand,
		agentArgv: identity.agentArgv ?? resolveAgentArgvForCommand(identity.agentCommand)
	};
}
function hasModelConfigOption(options) {
	if (!Array.isArray(options)) return false;
	return options.some((entry) => {
		const option = asRecord$2(entry);
		return option?.category === "model" || option?.id === "model";
	});
}
function parseConfigOptions(raw) {
	if (!Array.isArray(raw) || !raw.every((entry) => asRecord$2(entry) !== void 0)) return;
	return raw;
}
function parseAvailableCommand(raw) {
	if (typeof raw === "string") {
		const name = raw.trim();
		return name ? { name } : void 0;
	}
	const record = asRecord$2(raw);
	if (!record) return;
	const name = parseNonEmptyString$1(record.name);
	if (!name) return;
	const description = parseNonEmptyString$1(record.description);
	return {
		name,
		...description ? { description } : {},
		...typeof record.has_input === "boolean" ? { has_input: record.has_input } : {}
	};
}
function parseAvailableCommands(raw) {
	if (!Array.isArray(raw)) return;
	const commands = raw.map((entry) => parseAvailableCommand(entry)).filter((entry) => entry !== void 0);
	return commands.length > 0 ? commands : void 0;
}
function parseNonEmptyString$1(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function parseTokenUsage(raw) {
	if (raw === void 0 || raw === null) return;
	const record = asRecord$2(raw);
	if (!record) return null;
	const usage = {};
	for (const field of [
		"input_tokens",
		"output_tokens",
		"cache_creation_input_tokens",
		"cache_read_input_tokens",
		"thought_tokens",
		"total_tokens"
	]) {
		const value = record[field];
		if (value === void 0) continue;
		if (!isNonNegativeFiniteNumber(value)) return null;
		usage[field] = value;
	}
	return usage;
}
function isNonNegativeFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function parseUsageCost(raw) {
	if (raw === void 0 || raw === null) return;
	const record = asRecord$2(raw);
	if (!record) return null;
	return parseUsageCostRecord(record);
}
function parseUsageCostRecord(record) {
	const amount = parseCostAmount(record.amount);
	const currency = parseCostCurrency(record.currency);
	if (amount === null || currency === null) return null;
	const cost = {
		...amount !== void 0 ? { amount } : {},
		...currency !== void 0 ? { currency } : {}
	};
	return Object.keys(cost).length > 0 ? cost : void 0;
}
function parseCostAmount(value) {
	if (value === void 0) return;
	return isNonNegativeFiniteNumber(value) ? value : null;
}
function parseCostCurrency(value) {
	if (value === void 0) return;
	if (typeof value !== "string") return null;
	const currency = value.trim();
	return currency.length > 0 ? currency : void 0;
}
function parseRequestTokenUsage(raw) {
	if (raw === void 0 || raw === null) return;
	const record = asRecord$2(raw);
	if (!record) return null;
	const usage = {};
	for (const [key, value] of Object.entries(record)) {
		const parsed = parseTokenUsage(value);
		if (parsed == null) return null;
		Object.defineProperty(usage, key, {
			value: parsed,
			writable: true,
			enumerable: true,
			configurable: true
		});
	}
	return usage;
}
function isValidImageSize(size) {
	if (size === void 0 || size === null) return true;
	const record = asRecord$2(size);
	return !!record && isFiniteNumber(record.width) && isFiniteNumber(record.height);
}
function isSessionMessageImage(raw) {
	const record = asRecord$2(raw);
	if (!record || typeof record.source !== "string" || !isOptionalString(record.mime_type)) return false;
	return isValidImageSize(record.size);
}
function isSessionMessageAudio(raw) {
	const record = asRecord$2(raw);
	return !!record && typeof record.source === "string" && typeof record.mime_type === "string";
}
function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}
function isUserContent(raw) {
	const record = asRecord$2(raw);
	if (!record) return false;
	if (typeof record.Text === "string") return true;
	if (record.Mention !== void 0) {
		const mention = asRecord$2(record.Mention);
		return !!mention && typeof mention.uri === "string" && typeof mention.content === "string";
	}
	if (record.Image !== void 0) return isSessionMessageImage(record.Image);
	if (record.Audio !== void 0) return isSessionMessageAudio(record.Audio);
	return false;
}
function isToolUse(raw) {
	const record = asRecord$2(raw);
	return !!record && hasStringFields$1(record, [
		"id",
		"name",
		"raw_input"
	]) && hasOwn(record, "input") && typeof record.is_input_complete === "boolean" && isOptionalString(record.thought_signature);
}
function hasStringFields$1(record, keys) {
	return keys.every((key) => typeof record[key] === "string");
}
function isOptionalString(value) {
	return value === void 0 || value === null || typeof value === "string";
}
function isToolResultContent(raw) {
	const record = asRecord$2(raw);
	if (!record) return false;
	if (typeof record.Text === "string") return true;
	if (record.Image !== void 0) return isSessionMessageImage(record.Image);
	return false;
}
function isToolResult(raw) {
	const record = asRecord$2(raw);
	return !!record && typeof record.tool_use_id === "string" && typeof record.tool_name === "string" && typeof record.is_error === "boolean" && isToolResultContent(record.content);
}
function isAgentContent(raw) {
	const record = asRecord$2(raw);
	if (!record) return false;
	if (typeof record.Text === "string") return true;
	if (record.Thinking !== void 0) return isThinkingContent(record.Thinking);
	if (typeof record.RedactedThinking === "string") return true;
	if (record.ToolUse !== void 0) return isToolUse(record.ToolUse);
	return false;
}
function isThinkingContent(raw) {
	const thinking = asRecord$2(raw);
	return !!thinking && typeof thinking.text === "string" && isOptionalString(thinking.signature);
}
function isUserMessage(raw) {
	const record = asRecord$2(raw);
	if (!record || record.User === void 0) return false;
	const user = asRecord$2(record.User);
	return !!user && typeof user.id === "string" && Array.isArray(user.content) && user.content.every((entry) => isUserContent(entry));
}
function isAgentMessage(raw) {
	const record = asRecord$2(raw);
	if (!record || record.Agent === void 0) return false;
	const agent = asRecord$2(record.Agent);
	if (!agent || !Array.isArray(agent.content) || !agent.content.every(isAgentContent)) return false;
	const toolResults = asRecord$2(agent.tool_results);
	if (!toolResults) return false;
	return Object.values(toolResults).every(isToolResult);
}
function isConversationMessage(raw) {
	return raw === "Resume" || isUserMessage(raw) || isAgentMessage(raw);
}
function parseConversationRecord(record) {
	if (!hasValidConversationCore(record)) return;
	const title = parseConversationTitle(record.title);
	if (title === INVALID_VALUE) return;
	const cumulativeTokenUsage = parseTokenUsage(record.cumulative_token_usage);
	const cumulativeCost = parseUsageCost(record.cumulative_cost);
	const requestTokenUsage = parseRequestTokenUsage(record.request_token_usage);
	if (cumulativeTokenUsage === null || cumulativeCost === null || requestTokenUsage === null) return;
	return {
		title,
		messages: record.messages,
		updated_at: record.updated_at,
		cumulative_token_usage: cumulativeTokenUsage ?? {},
		cumulative_cost: cumulativeCost,
		request_token_usage: requestTokenUsage ?? {}
	};
}
const INVALID_VALUE = Symbol("invalid");
function parseConversationTitle(value) {
	if (value === void 0 || value === null || typeof value === "string") return value;
	return INVALID_VALUE;
}
function hasValidConversationCore(record) {
	return Array.isArray(record.messages) && record.messages.every(isConversationMessage) && typeof record.updated_at === "string";
}
function parseAcpxState(raw) {
	const record = asRecord$2(raw);
	if (!record) return;
	const state = {};
	if (record.session_origin === "new" || record.session_origin === "resume") state.session_origin = record.session_origin;
	if (record.reset_on_next_ensure === true) state.reset_on_next_ensure = true;
	assignStringState(state, "current_mode_id", record.current_mode_id);
	assignStringState(state, "desired_mode_id", record.desired_mode_id);
	const desiredConfigOptions = parseStringMap(record.desired_config_options);
	if (desiredConfigOptions) state.desired_config_options = desiredConfigOptions;
	const modelNames = parseStringMap(record.available_model_names, true);
	if (modelNames) state.available_model_names = modelNames;
	assignParsedModelState(state, record);
	const availableCommands = parseAvailableCommands(record.available_commands);
	if (availableCommands) state.available_commands = availableCommands;
	assignParsedSessionOptions(state, record.session_options);
	return state;
}
function assignParsedModelState(state, record) {
	assignStringState(state, "current_model_id", record.current_model_id);
	if (isStringArray(record.available_models)) state.available_models = [...record.available_models];
	if (record.model_control === "config_option" || record.model_control === "legacy_set_model") state.model_control = record.model_control;
	const configOptions = parseConfigOptions(record.config_options);
	if (configOptions) state.config_options = configOptions;
	if (state.model_control === void 0 && state.available_models !== void 0) state.model_control = hasModelConfigOption(state.config_options) ? "config_option" : "legacy_set_model";
}
function assignStringState(state, key, value) {
	if (typeof value === "string") state[key] = value;
}
function parseStringMap(raw, preserveEmpty = false) {
	const record = asRecord$2(raw);
	if (!record) return;
	const parsed = Object.fromEntries(Object.entries(record).filter((entry) => typeof entry[1] === "string"));
	return Object.keys(parsed).length > 0 || preserveEmpty ? parsed : void 0;
}
function assignParsedSessionOptions(state, raw) {
	const sessionOptions = asRecord$2(raw);
	if (!sessionOptions) return;
	const parsedSessionOptions = {};
	if (typeof sessionOptions.model === "string") parsedSessionOptions.model = sessionOptions.model;
	if (isStringArray(sessionOptions.allowed_tools)) parsedSessionOptions.allowed_tools = [...sessionOptions.allowed_tools];
	if (isPositiveInteger$1(sessionOptions.max_turns)) parsedSessionOptions.max_turns = sessionOptions.max_turns;
	assignSessionOptionSystemPrompt(parsedSessionOptions, sessionOptions.system_prompt);
	const env = parseStringMap(sessionOptions.env);
	if (env) parsedSessionOptions.env = env;
	if (Object.keys(parsedSessionOptions).length > 0) state.session_options = parsedSessionOptions;
}
function assignSessionOptionSystemPrompt(options, value) {
	if (typeof value === "string" && value.length > 0) {
		options.system_prompt = value;
		return;
	}
	const appendRecord = asRecord$2(value);
	if (appendRecord && typeof appendRecord.append === "string" && appendRecord.append.length > 0) options.system_prompt = { append: appendRecord.append };
}
function parseEventLog(raw, sessionId) {
	const record = asRecord$2(raw);
	if (!record || !hasValidEventLogCore(record)) return defaultSessionEventLog(sessionId);
	return {
		active_path: record.active_path,
		segment_count: record.segment_count,
		max_segment_bytes: record.max_segment_bytes,
		max_segments: record.max_segments,
		last_write_at: typeof record.last_write_at === "string" ? record.last_write_at : void 0,
		last_write_error: record.last_write_error == null || typeof record.last_write_error === "string" ? record.last_write_error : null
	};
}
function hasValidEventLogCore(record) {
	return typeof record.active_path === "string" && isPositiveInteger$1(record.segment_count) && isPositiveInteger$1(record.max_segment_bytes) && isPositiveInteger$1(record.max_segments);
}
function isPositiveInteger$1(value) {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function parseImportedFrom(raw) {
	if (raw == null) return;
	const record = asRecord$2(raw);
	if (!record || typeof record.record_id !== "string" || typeof record.cwd_original !== "string" || typeof record.exported_by !== "string" || typeof record.exported_at !== "string") return null;
	return {
		recordId: record.record_id,
		cwdOriginal: record.cwd_original,
		exportedBy: record.exported_by,
		exportedAt: record.exported_at
	};
}
function parseSessionRecordMetadata(record) {
	const lastRequestId = normalizeOptionalString(record.last_request_id);
	if (lastRequestId === null) return null;
	const importedFrom = parseImportedFrom(record.imported_from);
	if (importedFrom === null) return null;
	return {
		lastRequestId,
		importedFrom
	};
}
function normalizeOptionalName(value) {
	if (value == null) return;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function normalizeOptionalPid(value) {
	if (value == null) return;
	return isPositiveInteger$1(value) ? value : null;
}
function normalizeOptionalBoolean(value, fallback = false) {
	if (value == null) return fallback;
	return typeof value === "boolean" ? value : null;
}
function normalizeOptionalString(value) {
	if (value == null) return;
	return typeof value === "string" ? value : null;
}
function normalizeOptionalExitCode(value) {
	if (value === void 0) return;
	if (value === null) return null;
	if (Number.isInteger(value)) return value;
	return Symbol("invalid");
}
function normalizeOptionalSignal(value) {
	if (value === void 0) return;
	if (value === null) return null;
	if (typeof value === "string") return value;
	return Symbol("invalid");
}
function parseSessionRecord(raw) {
	const record = asRecord$2(raw);
	if (!record) return null;
	if (record.schema !== "acpx.session.v1") return null;
	const optionals = validSessionOptionals({
		name: normalizeOptionalName(record.name),
		pid: normalizeOptionalPid(record.pid),
		closed: normalizeOptionalBoolean(record.closed, false),
		closedAt: normalizeOptionalString(record.closed_at),
		agentStartedAt: normalizeOptionalString(record.agent_started_at),
		lastPromptAt: normalizeOptionalString(record.last_prompt_at),
		lastAgentExitCode: normalizeOptionalExitCode(record.last_agent_exit_code),
		lastAgentExitSignal: normalizeOptionalSignal(record.last_agent_exit_signal),
		lastAgentExitAt: normalizeOptionalString(record.last_agent_exit_at),
		lastAgentDisconnectReason: normalizeOptionalString(record.last_agent_disconnect_reason)
	});
	if (!hasValidSessionRecordCore(record) || !optionals) return null;
	const conversation = parseConversationRecord(record);
	if (!conversation) return null;
	const eventLog = parseEventLog(record.event_log, record.acpx_record_id);
	const metadata = parseSessionRecordMetadata(record);
	if (!metadata) return null;
	const agent = parsePersistedAgentIdentity(record.agent_command, record.agent_argv);
	return {
		schema: SESSION_RECORD_SCHEMA,
		acpxRecordId: record.acpx_record_id,
		acpSessionId: record.acp_session_id,
		agentSessionId: normalizeAgentSessionId(record.agent_session_id),
		agentCommand: agent.agentCommand,
		agentArgv: agent.agentArgv,
		cwd: record.cwd,
		name: optionals.name,
		createdAt: record.created_at,
		lastUsedAt: record.last_used_at,
		lastSeq: record.last_seq,
		lastRequestId: metadata.lastRequestId,
		eventLog,
		closed: optionals.closed,
		closedAt: optionals.closedAt,
		pid: optionals.pid,
		agentStartedAt: optionals.agentStartedAt,
		lastPromptAt: optionals.lastPromptAt,
		lastAgentExitCode: optionals.lastAgentExitCode,
		lastAgentExitSignal: optionals.lastAgentExitSignal,
		lastAgentExitAt: optionals.lastAgentExitAt,
		lastAgentDisconnectReason: optionals.lastAgentDisconnectReason,
		protocolVersion: typeof record.protocol_version === "number" ? record.protocol_version : void 0,
		agentCapabilities: asRecord$2(record.agent_capabilities),
		title: conversation.title,
		messages: conversation.messages,
		updated_at: conversation.updated_at,
		cumulative_token_usage: conversation.cumulative_token_usage,
		cumulative_cost: conversation.cumulative_cost,
		request_token_usage: conversation.request_token_usage,
		acpx: parseAcpxState(record.acpx),
		sessionMaterialization: parseSessionMaterialization(record.session_materialization),
		importedFrom: metadata.importedFrom
	};
}
function parseSessionMaterialization(value) {
	if (!value || value.state !== "pending" || value.contract !== "executablemd.session-materialization/v1") return;
	return { state: "pending", contract: "executablemd.session-materialization/v1" };
}
function hasValidSessionRecordCore(record) {
	return hasStringFields$1(record, [
		"acpx_record_id",
		"acp_session_id",
		"agent_command",
		"cwd",
		"created_at",
		"last_used_at"
	]) && typeof record.last_seq === "number" && Number.isInteger(record.last_seq) && record.last_seq >= 0;
}
function validSessionOptionals(options) {
	if (hasNullOptionalSessionFields(options) || hasInvalidExitStatus(options)) return null;
	return options;
}
function hasNullOptionalSessionFields(options) {
	return [
		options.name,
		options.pid,
		options.closed,
		options.closedAt,
		options.agentStartedAt,
		options.lastPromptAt,
		options.lastAgentExitAt,
		options.lastAgentDisconnectReason
	].some((value) => value === null);
}
function hasInvalidExitStatus(options) {
	return typeof options.lastAgentExitCode === "symbol" || typeof options.lastAgentExitSignal === "symbol";
}
// src/persisted-key-policy.ts
const SNAKE_CASE_KEY = /^[a-z][a-z0-9_]*$/;
const ZED_TAG_KEYS = /* @__PURE__ */ new Set([
	"User",
	"Agent",
	"Resume",
	"Text",
	"Mention",
	"Image",
	"Audio",
	"Thinking",
	"RedactedThinking",
	"ToolUse"
]);
const MAP_OBJECT_PATHS = /* @__PURE__ */ new Set([
	"request_token_usage",
	"messages.Agent.tool_results",
	"acpx.session_options.env",
	"acpx.available_model_names"
]);
const OPAQUE_VALUE_PATHS = /* @__PURE__ */ new Set([
	"agent_capabilities",
	"messages.Agent.content.ToolUse.input",
	"acpx.desired_config_options",
	"acpx.config_options"
]);
function isRecord(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function joinPath(path) {
	return path.join(".");
}
function shouldSkipKeyRule(path) {
	return MAP_OBJECT_PATHS.has(joinPath(path));
}
function shouldSkipDescend(path) {
	return OPAQUE_VALUE_PATHS.has(joinPath(path)) || isToolResultOutputPath(path);
}
function isToolResultOutputTail(path, toolResultsIndex) {
	return toolResultsIndex !== -1 && toolResultsIndex + 2 === path.length - 1;
}
function isToolResultOutputPath(path) {
	if (path.length < 5 || path[path.length - 1] !== "output") return false;
	const toolResultsIndex = path.lastIndexOf("tool_results");
	if (!isToolResultOutputTail(path, toolResultsIndex)) return false;
	return path.slice(0, toolResultsIndex + 1).join(".") === "messages.Agent.tool_results";
}
function collectViolations(value, path, violations) {
	if (Array.isArray(value)) {
		for (const entry of value) collectViolations(entry, path, violations);
		return;
	}
	if (!isRecord(value)) return;
	const skipKeyRule = shouldSkipKeyRule(path);
	for (const [key, child] of Object.entries(value)) collectKeyViolation(child, key, path, skipKeyRule, violations);
}
function collectKeyViolation(child, key, path, skipKeyRule, violations) {
	if (!skipKeyRule && !SNAKE_CASE_KEY.test(key) && !ZED_TAG_KEYS.has(key)) violations.push(`${joinPath(path)}.${key}`.replace(/^\./, ""));
	const childPath = [...path, key];
	if (!shouldSkipDescend(childPath)) collectViolations(child, childPath, violations);
}
function findPersistedKeyPolicyViolations(value) {
	const violations = [];
	collectViolations(value, [], violations);
	return violations;
}
function assertPersistedKeyPolicy(value) {
	const violations = findPersistedKeyPolicyViolations(value);
	if (violations.length === 0) return;
	throw new Error(`Persisted key policy violation (expected snake_case keys): ${violations.join(", ")}`);
}
// src/session/persistence/discovery.ts
const DISCOVERY_BATCH_SIZE = 4;
/** Select and return the same canonical snapshot; cached metadata cannot exclude records. */
async function* scanSessionRecords(sessionDir) {
	const files = (await fs$1.readdir(sessionDir, { withFileTypes: true }).catch((error) => {
		if (error.code === "ENOENT") return [];
		throw error;
	})).filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "index.json").map((entry) => entry.name).toSorted();
	for (let offset = 0; offset < files.length; offset += DISCOVERY_BATCH_SIZE) {
		const records = await Promise.all(files.slice(offset, offset + DISCOVERY_BATCH_SIZE).map((file) => readRecord(path.join(sessionDir, file))));
		for (const record of records) if (record) yield record;
	}
}
async function readRecord(file) {
	try {
		const payload = await fs$1.readFile(file, "utf8");
		const record = parseSessionRecord(JSON.parse(payload));
		return record && path.basename(file) === `${safeSessionId(record.acpxRecordId)}.json` ? record : void 0;
	} catch {
		return;
	}
}
// src/session/persistence/repository.ts
const DEFAULT_HISTORY_LIMIT = 20;
function sessionFilePath(acpxRecordId) {
	const safeId = safeSessionId(acpxRecordId);
	return path.join(sessionBaseDir(), `${safeId}.json`);
}
async function ensureSessionDir() {
	await fs$1.mkdir(sessionBaseDir(), {
		recursive: true,
		mode: 448
	});
}
async function* sessionRecords(readOnly = false) {
	if (!readOnly) await ensureSessionDir();
	yield* scanSessionRecords(sessionBaseDir());
}
/**
* Commands a scoped query matches: the query itself, plus the current built-in
* command when the query is an earlier built-in default (records under it are
* migrated on read unless they carry a custom launcher).
*/
function agentScope(agentCommand) {
	return /* @__PURE__ */ new Set([agentCommand, canonicalAgentCommand(agentCommand)]);
}
function matchesSession(session, scope, normalizedName, includeClosed = false) {
	if (!scope.has(session.agentCommand)) return false;
	if (!includeClosed && session.closed) return false;
	if (normalizedName == null) return session.name == null;
	return session.name === normalizedName;
}
function isNewer(record, previous) {
	return !previous || record.lastUsedAt.localeCompare(previous.lastUsedAt) > 0;
}
async function writeSessionRecord(record) {
	await measurePerf("session.write_record", async () => {
		const persisted = serializeSessionRecordForDisk(record);
		assertPersistedKeyPolicy(persisted);
		await writePrivateJsonFile(sessionFilePath(record.acpxRecordId), persisted);
	});
}
async function resolveSessionRecord(sessionId) {
	await ensureSessionDir();
	try {
		const directRecord = await measurePerf("session.resolve_direct", async () => await readSessionRecord(sessionId));
		if (directRecord?.acpxRecordId === sessionId) return directRecord;
	} catch {}
	const { exactRecords, suffixRecords } = await findSessionIdMatches(sessionId);
	if (exactRecords.length === 1) return exactRecords[0];
	if (exactRecords.length > 1) throw new SessionResolutionError(`Multiple sessions match id: ${sessionId}`);
	if (suffixRecords.length === 1) return suffixRecords[0];
	if (suffixRecords.length > 1) throw new SessionResolutionError(`Session id is ambiguous: ${sessionId}`);
	incrementPerfCounter("session.resolve_miss");
	throw new SessionNotFoundError(sessionId);
}
async function findSessionIdMatches(sessionId) {
	const exactRecords = [];
	const suffixRecords = [];
	for await (const record of sessionRecords()) {
		if (record.acpxRecordId === sessionId || record.acpSessionId === sessionId) retainMatch(exactRecords, record);
		if (record.acpxRecordId.endsWith(sessionId) || record.acpSessionId.endsWith(sessionId)) retainMatch(suffixRecords, record);
	}
	return {
		exactRecords,
		suffixRecords
	};
}
function retainMatch(matches, record) {
	if (matches.length < 2) matches.push(record);
}
/** Reads one canonical record without creating directories or scanning other sessions. */
async function readSessionRecord(sessionId) {
	let payload;
	try {
		payload = await fs$1.readFile(sessionFilePath(sessionId), "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return;
		throw error;
	}
	try {
		const record = parseSessionRecord(JSON.parse(payload));
		return record?.acpxRecordId === sessionId ? record : void 0;
	} catch {
		return;
	}
}
function hasGitMarker(dir) {
	const gitPath = path.join(dir, ".git");
	try {
		const marker = statSync(gitPath);
		return marker.isDirectory() || marker.isFile();
	} catch {
		return false;
	}
}
function isWithinBoundary(boundary, target) {
	const relative = path.relative(boundary, target);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function absolutePath(value) {
	return path.resolve(value);
}
function findGitRepositoryRoot(startDir) {
	let current = absolutePath(startDir);
	const root = path.parse(current).root;
	for (;;) {
		if (hasGitMarker(current)) return current;
		if (current === root) return;
		const parent = path.dirname(current);
		if (parent === current) return;
		current = parent;
	}
}
function normalizeName(value) {
	if (value == null) return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function isoNow() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
async function listSessions() {
	return await collectSessionRecords();
}
async function listSessionsForAgent(agentCommand) {
	return await collectSessionRecords(agentCommand);
}
async function collectSessionRecords(agentCommand) {
	const scope = agentCommand === void 0 ? void 0 : agentScope(agentCommand);
	const records = [];
	for await (const record of sessionRecords()) if (scope === void 0 || scope.has(record.agentCommand)) records.push(record);
	return records.toSorted((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}
async function findSession(options) {
	const normalizedCwd = absolutePath(options.cwd);
	const normalizedName = normalizeName(options.name);
	const scope = agentScope(options.agentCommand);
	let match;
	for await (const record of sessionRecords(options.readOnly)) if (record.cwd === normalizedCwd && matchesSession(record, scope, normalizedName, options.includeClosed) && isNewer(record, match)) match = record;
	return match;
}
async function findSessionByDirectoryWalk(options) {
	const normalizedName = normalizeName(options.name);
	const scope = agentScope(options.agentCommand);
	const directories = walkDirectories(options);
	let match;
	let distance = Infinity;
	for await (const record of sessionRecords()) {
		const candidateDistance = directories.get(record.cwd);
		if (candidateDistance !== void 0 && matchesSession(record, scope, normalizedName) && (candidateDistance < distance || candidateDistance === distance && isNewer(record, match))) {
			match = record;
			distance = candidateDistance;
		}
	}
	return match;
}
function walkDirectories(options) {
	const normalizedStart = absolutePath(options.cwd);
	const normalizedBoundary = absolutePath(options.boundary ?? normalizedStart);
	const walkBoundary = isWithinBoundary(normalizedBoundary, normalizedStart) ? normalizedBoundary : normalizedStart;
	const directories = /* @__PURE__ */ new Map();
	const walkRoot = path.parse(normalizedStart).root;
	let current = normalizedStart;
	while (current) {
		directories.set(current, directories.size);
		current = nextWalkParent(current, walkBoundary, walkRoot);
	}
	return directories;
}
function nextWalkParent(current, walkBoundary, walkRoot) {
	if (current === walkBoundary || current === walkRoot) return;
	const parent = path.dirname(current);
	if (parent === current || !isWithinBoundary(walkBoundary, parent)) return;
	return parent;
}
function closedAtOrLastUsedAt(record) {
	return record.closedAt ?? record.lastUsedAt;
}
function isSessionStreamFile(fileName, safeId) {
	const segmentPrefix = `${safeId}.stream.`;
	return fileName === `${safeId}.stream.ndjson` || fileName === `${safeId}.stream.lock` || fileName.startsWith(segmentPrefix) && /^\d+\.ndjson$/.test(fileName.slice(segmentPrefix.length));
}
async function pruneSessions(options = {}) {
	const records = await loadPrunableRecords(options.before ?? (options.olderThanMs != null ? new Date(Date.now() - options.olderThanMs) : void 0), options.agentCommand);
	if (options.dryRun) return {
		pruned: records,
		bytesFreed: 0,
		dryRun: true
	};
	const sessionDir = sessionBaseDir();
	let bytesFreed = 0;
	let dirEntries = [];
	if (options.includeHistory) try {
		dirEntries = await fs$1.readdir(sessionDir);
	} catch {}
	for (const record of records) bytesFreed += await pruneSessionFiles(record, sessionDir, dirEntries, options.includeHistory === true);
	return {
		pruned: records,
		bytesFreed,
		dryRun: false
	};
}
function isPruneCandidate(record, scope) {
	return record.closed === true && (!scope || scope.has(record.agentCommand));
}
async function loadPrunableRecords(cutoff, agentCommand) {
	const records = [];
	const cutoffIso = cutoff?.toISOString();
	const scope = agentCommand === void 0 ? void 0 : agentScope(agentCommand);
	for await (const record of sessionRecords()) if (isPruneCandidate(record, scope) && isBeforeCutoff(record, cutoffIso)) records.push(record);
	return records.toSorted((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}
function isBeforeCutoff(record, cutoffIso) {
	return !cutoffIso || closedAtOrLastUsedAt(record) < cutoffIso;
}
async function pruneSessionFiles(record, sessionDir, dirEntries, includeHistory) {
	const safeId = safeSessionId(record.acpxRecordId);
	let bytesFreed = await unlinkCountingBytes(path.join(sessionDir, `${safeId}.json`));
	if (includeHistory) for (const name of dirEntries.filter((entry) => isSessionStreamFile(entry, safeId))) bytesFreed += await unlinkCountingBytes(path.join(sessionDir, name));
	return bytesFreed;
}
async function unlinkCountingBytes(filePath) {
	let bytes = 0;
	try {
		bytes = (await fs$1.stat(filePath)).size;
	} catch {}
	await fs$1.unlink(filePath).catch(() => void 0);
	return bytes;
}
// src/process-identity.ts
const IDENTITY_QUERY_TIMEOUT_MS$1 = 2e3;
const LINUX_PROCESS_QUERY = `
  const fs = require('node:fs/promises');
  const [targetPid, observerPid] = process.argv.slice(1);
  if (process.ppid !== Number(observerPid)) process.exit(1);
  const timeNamespace = (pid) => fs.readlink('/proc/' + pid + '/ns/time').catch((error) => {
    if (error.code === 'ENOENT') return 'unsupported';
    throw error;
  });
  const prefix = async (name, size) => {
    const file = await fs.open(name, 'r');
    try {
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await file.read(buffer, 0, size, 0);
      return buffer.subarray(0, bytesRead).toString('base64');
    } finally { await file.close(); }
  };
  const targets = async () => {
    if (targetPid !== 'all') {
      return { targetStat: await fs.readFile('/proc/' + targetPid + '/stat', 'utf8').catch(() => null) };
    }
    const required = new Set(JSON.parse(process.argv[3] || '[]'));
    const pids = new Set((await fs.readdir('/proc')).filter(pid => /^[1-9][0-9]*$/.test(pid)));
    for (const pid of required) pids.add(String(pid));
    const processStats = [];
    let bytes = 0;
    // Sequential reads keep proc I/O and retained memory bounded within this
    // single killable helper; never launch one helper or pending read per PID.
    for (const pid of [...pids].sort((a, b) => Number(a) - Number(b))) {
      let stat;
      try { stat = await fs.readFile('/proc/' + pid + '/stat', 'utf8'); }
      catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
        if (!required.has(Number(pid)) && (error.code === 'EACCES' || error.code === 'EPERM')) continue;
        throw error;
      }
      bytes += Buffer.byteLength(JSON.stringify(stat)) + 1;
      if (bytes > ${PROCESS_HELPER_MAX_BUFFER_BYTES} - 8192) throw new Error('Process table exceeds its byte limit');
      processStats.push(stat);
    }
    return { processStats, auxv: await prefix('/proc/self/auxv', 4096), elf: await prefix('/proc/self/exe', 6) };
  };
  Promise.all([
    fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    fs.readlink('/proc/self/ns/pid'),
    timeNamespace('self'),
    fs.readlink('/proc/' + observerPid + '/ns/pid'),
    timeNamespace(observerPid),
    fs.readFile('/proc/self/stat', 'utf8'),
    targets(),
  ]).then(([bootId, pidNamespace, timeNamespace, observerPidNamespace,
    observerTimeNamespace, selfStat, target]) => {
    process.stdout.write(JSON.stringify({bootId: bootId.trim(), pidNamespace,
      timeNamespace, observerPidNamespace, observerTimeNamespace,
      helperPid: process.pid, selfStat, ...target}));
  }).catch(() => { process.exitCode = 1; });
`;
const POSIX_MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec"
];
let ownIdentity;
let ownIdentityPending;
function parseProcessBirthIdentity(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
	const identity = raw;
	if (identity.kind === "linux-proc") return parseLinuxIdentity(identity);
	if (identity.kind !== "posix-lstart" && identity.kind !== "windows-creation") return;
	if (!isCanonicalBirth(identity.value, identity.kind)) return;
	return {
		kind: identity.kind,
		value: identity.value
	};
}
function isCanonicalBirth(value, kind) {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,7}Z$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
	const canonical = new Date(value).toISOString();
	return canonical.slice(0, 19) === value.slice(0, 19) && (kind === "posix-lstart" ? value === canonical && value.endsWith(".000Z") : /\.\d{7}Z$/.test(value));
}
function parseLinuxScope(raw) {
	const { bootId, pidNamespace, timeNamespace } = raw;
	if (typeof bootId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(bootId) || typeof pidNamespace !== "string" || !/^pid:\[[1-9]\d*\]$/.test(pidNamespace) || !isTimeNamespace(timeNamespace)) return;
	return {
		bootId,
		pidNamespace,
		timeNamespace
	};
}
function isTimeNamespace(value) {
	return typeof value === "string" && (value === "unsupported" || /^time:\[[1-9]\d*\]$/.test(value));
}
function isStartTicks(value) {
	return typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value);
}
function parseLinuxIdentity(raw) {
	const scope = parseLinuxScope(raw);
	if (!scope || !isStartTicks(raw.startTicks)) return;
	return {
		kind: "linux-proc",
		...scope,
		startTicks: raw.startTicks
	};
}
function compareLinuxScope(expected, observed) {
	if (expected.bootId !== observed.bootId) return "different";
	if (expected.pidNamespace !== observed.pidNamespace || expected.timeNamespace !== observed.timeNamespace) return "unknown";
	return "matching";
}
function compareLinuxIdentity(expected, observed) {
	const scope = compareLinuxScope(expected, observed);
	return scope === "matching" ? expected.startTicks === observed.startTicks ? "matching" : "different" : scope;
}
function compareProcessBirthIdentity(expected, observed) {
	if (!expected || expected.kind !== observed.kind) return "unknown";
	if (expected.kind === "linux-proc" && observed.kind === "linux-proc") return compareLinuxIdentity(expected, observed);
	if ("value" in expected && "value" in observed) return expected.value === observed.value ? "matching" : "different";
	return "unknown";
}
function parseLinuxStat(raw) {
	if (typeof raw !== "string") return;
	const prefix = /^(\d+) \(/.exec(raw);
	const close = raw.lastIndexOf(")");
	if (!prefix || close < 0) return;
	const pid = Number(prefix[1]);
	const fields = raw.slice(close + 2).trim().split(/\s+/u);
	const startTicks = fields[19];
	if (!isPositivePid(pid) || !isStartTicks(startTicks) || !/^[RSDTtKWPI]$/.test(fields[0])) return;
	const parentPid = Number(fields[1]);
	const groupPid = Number(fields[2]);
	return validProcessLinks(parentPid, groupPid) ? {
		pid,
		parentPid,
		groupPid,
		startTicks
	} : void 0;
}
function validProcessLinks(parentPid, groupPid) {
	return Number.isSafeInteger(parentPid) && parentPid >= 0 && Number.isSafeInteger(groupPid) && groupPid >= 0;
}
async function readLinuxQuery(pid, timeoutMs, requiredPids = []) {
	const args = [
		"--input-type=commonjs",
		"-e",
		LINUX_PROCESS_QUERY,
		String(pid),
		String(process.pid)
	];
	if (pid === "all") args.push(JSON.stringify(requiredPids));
	const output = await runTimedExecFile(process.execPath, args, {
		timeoutMs,
		maxBufferBytes: pid === "all" ? PROCESS_HELPER_MAX_BUFFER_BYTES : 8192,
		env: {
			...process.env,
			NODE_OPTIONS: ""
		}
	});
	return JSON.parse(output);
}
function verifiedLinuxScope(raw) {
	const scope = parseLinuxScope(raw);
	const self = parseLinuxStat(raw.selfStat);
	if (!scope || !self || self.pid !== raw.helperPid || scope.pidNamespace !== raw.observerPidNamespace || scope.timeNamespace !== raw.observerTimeNamespace) return;
	return scope;
}
async function readLinuxObservation(pid, timeoutMs) {
	const raw = await readLinuxQuery(pid, timeoutMs);
	const scope = verifiedLinuxScope(raw);
	if (!scope) return;
	const target = parseLinuxStat(raw.targetStat);
	return {
		scope,
		...target?.pid === pid ? { identity: {
			kind: "linux-proc",
			...scope,
			startTicks: target.startTicks
		} } : {}
	};
}
function linuxAuxv(raw) {
	if (typeof raw.elf !== "string" || typeof raw.auxv !== "string") throw new Error("Linux process clock is unavailable");
	const elf = Buffer.from(raw.elf, "base64");
	const auxv = Buffer.from(raw.auxv, "base64");
	if (elf.subarray(0, 4).toString("hex") !== "7f454c46" || ![1, 2].includes(elf[4]) || ![1, 2].includes(elf[5])) throw new Error("Linux process clock has an invalid ELF format");
	return {
		auxv,
		size: elf[4] === 1 ? 4 : 8,
		littleEndian: elf[5] === 1
	};
}
function linuxClockTicks(raw) {
	const { auxv, size, littleEndian } = linuxAuxv(raw);
	const word = (offset) => readAuxvWord(auxv, offset, size, littleEndian);
	for (let offset = 0; offset + size * 2 <= auxv.length; offset += size * 2) {
		const key = word(offset);
		if (key === 0n) break;
		if (key === 17n && word(offset + size) > 0n) return word(offset + size);
	}
	throw new Error("Linux process clock has no AT_CLKTCK");
}
function readAuxvWord(buffer, offset, size, littleEndian) {
	if (size === 8) return littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);
	return BigInt(littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));
}
async function readLinuxProcessTable(timeoutMs, requiredPids, pid) {
	const raw = await readLinuxQuery("all", timeoutMs, requiredPids);
	const scope = verifiedLinuxScope(raw);
	if (!scope || !Array.isArray(raw.processStats)) throw new Error("Linux process table scope is unverified");
	const clockTicksPerSecond = linuxClockTicks(raw);
	const table = /* @__PURE__ */ new Map();
	for (const value of raw.processStats) {
		const stat = parseLinuxStat(value);
		if (stat && (pid === void 0 || stat.pid === pid)) table.set(stat.pid, {
			pid: stat.pid,
			parentPid: stat.parentPid,
			groupPid: stat.groupPid,
			birth: {
				kind: "linux-proc",
				...scope,
				startTicks: stat.startTicks
			},
			clockTicksPerSecond
		});
	}
	return table;
}
function readLinuxExitClock() {
	let descriptor;
	try {
		descriptor = fs.openSync("/proc/uptime", "r");
		const buffer = Buffer.alloc(64);
		const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
		const match = /^(\d+)\.(\d{2})\s/u.exec(buffer.toString("ascii", 0, bytes));
		return match ? {
			centiseconds: BigInt(match[1]) * 100n + BigInt(match[2]),
			timeNamespace: readOwnTimeNamespace()
		} : void 0;
	} catch {
		return;
	} finally {
		if (descriptor !== void 0) try {
			fs.closeSync(descriptor);
		} catch {}
	}
}
function readOwnTimeNamespace() {
	try {
		return fs.readlinkSync("/proc/self/ns/time");
	} catch (error) {
		if (error.code === "ENOENT") return "unsupported";
		throw error;
	}
}
function isPositivePid(pid) {
	return Number.isSafeInteger(pid) && pid > 0;
}
function windowsPowerShellPath() {
	const systemRoot = process.env.SystemRoot;
	if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error("Windows system directory is unavailable");
	return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
function windowsProcessQuery(pid) {
	return [
		"$ErrorActionPreference = 'Stop'",
		`Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate${pid === void 0 ? "" : ` -Filter 'ProcessId = ${pid}'`} | ForEach-Object {`,
		"if ($null -ne $_.CreationDate) {",
		"'{0} {1} 0 S {2}' -f $_.ProcessId,$_.ParentProcessId,$_.CreationDate.ToUniversalTime().ToString('o')",
		"}",
		"}"
	].join("\n");
}
function posixBirth(value) {
	const match = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(value);
	if (!match) return;
	const month = POSIX_MONTHS.indexOf(match[1]);
	if (month < 0) return;
	const valueUtc = `${match[6]}-${String(month + 1).padStart(2, "0")}-${match[2].padStart(2, "0")}T${match[3]}:${match[4]}:${match[5]}.000Z`;
	return isCanonicalBirth(valueUtc, "posix-lstart") ? valueUtc : void 0;
}
function parseProcessTable(output) {
	const table = /* @__PURE__ */ new Map();
	for (const line of output.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
		if (!match || match[4].startsWith("Z")) continue;
		const pid = Number(match[1]);
		const birth = processTableBirth(match[5]);
		if (Number.isSafeInteger(pid) && pid > 0 && birth) table.set(pid, {
			pid,
			parentPid: Number(match[2]),
			groupPid: Number(match[3]),
			birth: processBirthIdentity(birth)
		});
	}
	return table;
}
function processTableBirth(value) {
	if (process.platform !== "win32") return posixBirth(value);
	return isCanonicalBirth(value, "windows-creation") ? value : void 0;
}
async function readProcessTable(timeoutMs, pid, requiredPids = []) {
	if (pid !== void 0 && (!Number.isSafeInteger(pid) || pid <= 0)) throw new Error("Process identity requires a positive PID");
	if (process.platform === "win32") return parseProcessTable(await runTimedExecFile(windowsPowerShellPath(), [
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		windowsProcessQuery(pid)
	], {
		timeoutMs,
		windowsHide: true
	}));
	if (process.platform === "linux") return await readLinuxProcessTable(timeoutMs, requiredPids, pid);
	return parseProcessTable(await runTimedExecFile("ps", [
		...pid === void 0 ? ["-e"] : ["-p", String(pid)],
		"-o",
		"pid=,ppid=,pgid=,stat=,lstart="
	], {
		timeoutMs,
		env: {
			...process.env,
			LC_ALL: "C",
			TZ: "UTC"
		}
	}));
}
async function probeProcessIdentity(pid, timeoutMs = IDENTITY_QUERY_TIMEOUT_MS$1) {
	if (!isPositivePid(pid)) return { state: "unknown" };
	if (isProcessDefinitelyDead(pid)) return { state: "dead" };
	try {
		const identity = await readNativeIdentity(pid, timeoutMs);
		if (identity) return {
			state: "alive",
			identity
		};
	} catch {}
	return { state: isProcessDefinitelyDead(pid) ? "dead" : "unknown" };
}
async function readNativeIdentity(pid, timeoutMs) {
	if (process.platform === "linux") return (await readLinuxObservation(pid, timeoutMs))?.identity;
	return (await readProcessTable(timeoutMs, pid)).get(pid)?.birth;
}
function processBirthIdentity(value) {
	return {
		kind: process.platform === "win32" ? "windows-creation" : "posix-lstart",
		value
	};
}
function nativeIdentityKind() {
	if (process.platform === "linux") return "linux-proc";
	return process.platform === "win32" ? "windows-creation" : "posix-lstart";
}
function comparisonToIncarnation(comparison) {
	return comparison === "different" ? "gone" : comparison;
}
async function observeLinuxIncarnation(pid, expected, timeoutMs) {
	const observed = await readLinuxObservation(pid, timeoutMs).catch(() => void 0);
	if (!observed) return "unknown";
	const scope = compareLinuxScope(expected, observed.scope);
	if (scope !== "matching") return comparisonToIncarnation(scope);
	if (isProcessDefinitelyDead(pid)) return "gone";
	return observed.identity ? comparisonToIncarnation(compareProcessBirthIdentity(expected, observed.identity)) : "unknown";
}
async function observeProcessIncarnation(pid, expected, timeoutMs = IDENTITY_QUERY_TIMEOUT_MS$1) {
	if (!isPositivePid(pid)) return "unknown";
	if (expected?.kind === "linux-proc") return process.platform === "linux" ? await observeLinuxIncarnation(pid, expected, timeoutMs) : "unknown";
	if (expected && expected.kind !== nativeIdentityKind()) return "unknown";
	return await observeTimestampIncarnation(pid, expected, timeoutMs);
}
async function observeTimestampIncarnation(pid, expected, timeoutMs) {
	if (isProcessDefinitelyDead(pid)) return "gone";
	if (!expected) return "unknown";
	const observed = await probeProcessIdentity(pid, timeoutMs);
	if (observed.state === "dead") return "gone";
	return observed.state === "alive" ? comparisonToIncarnation(compareProcessBirthIdentity(expected, observed.identity)) : "unknown";
}
async function getOwnProcessIdentity() {
	if (ownIdentity) return ownIdentity;
	ownIdentityPending ??= probeProcessIdentity(process.pid).then((probe) => {
		if (probe.state === "alive") ownIdentity = probe.identity;
		return ownIdentity;
	}).finally(() => {
		ownIdentityPending = void 0;
	});
	return await ownIdentityPending;
}
// src/session/lock-owner.ts
const OBSERVATION_REUSE_MS = 1e3;
const IDENTITY_QUERY_TIMEOUT_MS = 1e3;
function lockOwnerPid(value) {
	if (!value || typeof value !== "object" || !("pid" in value)) return;
	const pid = value.pid;
	return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : void 0;
}
function canReuseObservation(preserved, pid, identity, fresh) {
	return !fresh && preserved?.pid === pid && compareProcessBirthIdentity(preserved.identity, identity) === "matching" && performance.now() - preserved.checkedAt < OBSERVATION_REUSE_MS;
}
async function createLockOwner(options = {}) {
	const { signal, capturedIdentity } = options;
	signal?.throwIfAborted();
	const processIdentity = capturedIdentity === void 0 ? await getOwnProcessIdentity() : capturedIdentity.processIdentity;
	signal?.throwIfAborted();
	let preserved;
	return {
		payload: {
			pid: process.pid,
			processIdentity
		},
		async hasExited(payload, fresh, signal) {
			signal?.throwIfAborted();
			const pid = lockOwnerPid(payload);
			if (!pid) return false;
			const identity = parseProcessBirthIdentity(payload.processIdentity);
			if (identity && canReuseObservation(preserved, pid, identity, fresh)) return false;
			const incarnation = await observeProcessIncarnation(pid, identity, IDENTITY_QUERY_TIMEOUT_MS);
			signal?.throwIfAborted();
			if (identity && incarnation !== "gone") preserved = {
				pid,
				identity,
				checkedAt: performance.now()
			};
			return incarnation === "gone";
		}
	};
}
// src/prompt-content.ts
var PromptInputValidationError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "PromptInputValidationError";
	}
};
function asRecord$1(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function isNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}
function isBase64Data(value) {
	if (value.length === 0 || value.length % 4 !== 0) return false;
	return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}
function isImageMimeType(value) {
	return /^image\/[A-Za-z0-9.+-]+$/i.test(value);
}
function isAudioMimeType(value) {
	return /^audio\/[A-Za-z0-9.+-]+$/i.test(value);
}
function isTextBlock(value) {
	const record = asRecord$1(value);
	return record?.type === "text" && typeof record.text === "string";
}
function isImageBlock(value) {
	const record = asRecord$1(value);
	return record?.type === "image" && isNonEmptyString(record.mimeType) && isImageMimeType(record.mimeType) && typeof record.data === "string" && isBase64Data(record.data);
}
function isAudioBlock(value) {
	const record = asRecord$1(value);
	return record?.type === "audio" && isNonEmptyString(record.mimeType) && isAudioMimeType(record.mimeType) && typeof record.data === "string" && isBase64Data(record.data);
}
function isResourceLinkBlock(value) {
	const record = asRecord$1(value);
	return record?.type === "resource_link" && isNonEmptyString(record.uri) && (record.title == null || typeof record.title === "string") && typeof record.name === "string";
}
function isResourcePayload(value) {
	const record = asRecord$1(value);
	if (!record || !isNonEmptyString(record.uri)) return false;
	return typeof record.text === "string" || typeof record.blob === "string";
}
function isResourceBlock(value) {
	const record = asRecord$1(value);
	return record?.type === "resource" && isResourcePayload(record.resource);
}
const CONTENT_BLOCK_VALIDATORS = [
	isTextBlock,
	isImageBlock,
	isAudioBlock,
	isResourceLinkBlock,
	isResourceBlock
];
function isContentBlock(value) {
	return CONTENT_BLOCK_VALIDATORS.some((validator) => validator(value));
}
const CONTENT_BLOCK_ERROR_VALIDATORS = {
	text: validateTextContentBlock,
	image: validateImageContentBlock,
	audio: validateAudioContentBlock,
	resource_link: validateResourceLinkContentBlock,
	resource: validateResourceContentBlock
};
function contentBlockErrorValidator(type) {
	return Object.hasOwn(CONTENT_BLOCK_ERROR_VALIDATORS, type) ? CONTENT_BLOCK_ERROR_VALIDATORS[type] : void 0;
}
function validateTextContentBlock(record, index) {
	return typeof record.text === "string" ? void 0 : `prompt[${index}] text block must include a string text field`;
}
function validateImageContentBlock(record, index) {
	if (!isNonEmptyString(record.mimeType)) return `prompt[${index}] image block must include a non-empty mimeType`;
	if (!isImageMimeType(record.mimeType)) return `prompt[${index}] image block mimeType must start with image/`;
	if (typeof record.data !== "string" || record.data.length === 0) return `prompt[${index}] image block must include non-empty base64 data`;
	return isBase64Data(record.data) ? void 0 : `prompt[${index}] image block data must be valid base64`;
}
function validateAudioContentBlock(record, index) {
	if (!isNonEmptyString(record.mimeType)) return `prompt[${index}] audio block must include a non-empty mimeType`;
	if (!isAudioMimeType(record.mimeType)) return `prompt[${index}] audio block mimeType must start with audio/`;
	if (typeof record.data !== "string" || record.data.length === 0) return `prompt[${index}] audio block must include non-empty base64 data`;
	return isBase64Data(record.data) ? void 0 : `prompt[${index}] audio block data must be valid base64`;
}
function validateResourceLinkContentBlock(record, index) {
	if (!isNonEmptyString(record.uri)) return `prompt[${index}] resource_link block must include a non-empty uri`;
	if (record.title != null && typeof record.title !== "string") return `prompt[${index}] resource_link block title must be a string or null when present`;
	if (typeof record.name !== "string") return `prompt[${index}] resource_link block must include a string name`;
}
function validateResourceContentBlock(record, index) {
	if (!asRecord$1(record.resource)) return `prompt[${index}] resource block must include a resource object`;
	return isResourcePayload(record.resource) ? void 0 : `prompt[${index}] resource block resource must include a non-empty uri and a string text or blob field`;
}
function getContentBlockValidationError(value, index) {
	const record = asRecord$1(value);
	if (!record || typeof record.type !== "string") return `prompt[${index}] must be an ACP content block object`;
	const validator = contentBlockErrorValidator(record.type);
	return validator ? validator(record, index) : `prompt[${index}] has unsupported content block type ${JSON.stringify(record.type)}`;
}
function isPromptInput(value) {
	return Array.isArray(value) && value.every((entry) => isContentBlock(entry));
}
function promptCapabilityRequirement(block) {
	switch (block.type) {
		case "image": return {
			blockType: "image",
			capability: "image"
		};
		case "audio": return {
			blockType: "audio",
			capability: "audio"
		};
		case "resource": return {
			blockType: "resource",
			capability: "embeddedContext"
		};
		default: return;
	}
}
function getUnsupportedPromptContentMessage(prompt, agentCapabilities) {
	for (const [index, block] of prompt.entries()) {
		const requirement = promptCapabilityRequirement(block);
		if (!requirement) continue;
		if (agentCapabilities?.promptCapabilities?.[requirement.capability] === true) continue;
		return `prompt[${index}] ${requirement.blockType} content requires agentCapabilities.promptCapabilities.${requirement.capability}`;
	}
}
function textPrompt(text) {
	return [{
		type: "text",
		text
	}];
}
function parseStructuredPrompt(source) {
	if (!source.startsWith("[")) return;
	try {
		const parsed = JSON.parse(source);
		if (isPromptInput(parsed)) return parsed;
		if (Array.isArray(parsed)) throw new PromptInputValidationError(parsed.map((entry, index) => getContentBlockValidationError(entry, index)).find((message) => message !== void 0) ?? "Structured prompt JSON must be an array of valid ACP content blocks");
		return;
	} catch (error) {
		if (error instanceof PromptInputValidationError) throw error;
		return;
	}
}
function parsePromptSource(source) {
	const trimmed = source.trim();
	const structured = parseStructuredPrompt(trimmed);
	if (structured) return structured;
	if (!trimmed) return [];
	return textPrompt(trimmed);
}
function mergePromptSourceWithText(source, suffixText) {
	const prompt = parsePromptSource(source);
	const appended = suffixText.trim();
	if (!appended) return prompt;
	if (prompt.length === 0) return textPrompt(appended);
	return [...prompt, ...textPrompt(appended)];
}
function promptToDisplayText(prompt) {
	return prompt.map((block) => contentBlockDisplayText(block)).filter((entry) => entry.trim().length > 0).join("\n\n").trim();
}
function contentBlockDisplayText(block) {
	switch (block.type) {
		case "text": return block.text;
		case "resource_link": return block.title ?? block.name ?? block.uri;
		case "resource": return resourceBlockDisplayText(block);
		case "image": return `[image] ${block.mimeType}`;
		case "audio": return `[audio] ${block.mimeType}`;
		default: return "";
	}
}
function resourceBlockDisplayText(block) {
	return "text" in block.resource && typeof block.resource.text === "string" ? block.resource.text : block.resource.uri;
}
// src/acp/process-descendants.ts
function hasStaleWindowsParent(identity, parent) {
	return identity.birth.kind === "windows-creation" && (parent?.birth.kind !== "windows-creation" || parent.birth.value > identity.birth.value);
}
function includeProcessDescendants(table, owned) {
	let expanded;
	do {
		expanded = false;
		for (const identity of table.values()) {
			if (hasStaleWindowsParent(identity, table.get(identity.parentPid))) continue;
			if (owned.has(identity.parentPid) && !owned.has(identity.pid)) {
				owned.add(identity.pid);
				expanded = true;
			}
		}
	} while (expanded);
}
/** Best-effort cleanup for descendants witnessed during this child launch. */
var ProcessDescendants = class {
	child;
	identities = /* @__PURE__ */ new Map();
	rootBirth;
	pending;
	retired = false;
	failedRootObservation = false;
	unresolvedOwnership = false;
	ownProcessGroup;
	captureGroupAfterExit;
	groupExitedAt;
	onRootExit = () => {
		this.groupExitedAt = process.platform === "linux" ? readLinuxExitClock() ?? null : Date.now();
	};
	constructor(child, options = {}) {
		this.child = child;
		this.ownProcessGroup = process.platform !== "win32" && Boolean(options.ownProcessGroup);
		this.captureGroupAfterExit = this.ownProcessGroup && isChildProcessRunning(child);
		if (this.ownProcessGroup) child.once("exit", this.onRootExit);
	}
	capture(timeoutMs = PROCESS_HELPER_TIMEOUT_MS) {
		if (this.retired) return Promise.resolve(true);
		this.pending ??= this.readSnapshot(timeoutMs).finally(() => {
			this.pending = void 0;
		});
		return this.pending;
	}
	async readSnapshot(timeoutMs) {
		const deadline = performance.now() + timeoutMs;
		const rootWasRunning = isChildProcessRunning(this.child);
		const captureRootGroup = rootWasRunning || this.captureGroupAfterExit;
		if (!rootWasRunning) this.captureGroupAfterExit = false;
		try {
			const table = await readProcessTable(timeoutMs, void 0, this.requiredSnapshotPids(rootWasRunning));
			if (!this.retired) {
				table.delete(1);
				table.delete(process.pid);
				this.refresh(table, captureRootGroup);
				if (this.captureGroupAfterExit && !isChildProcessRunning(this.child)) return await this.readSnapshot(Math.max(1, deadline - performance.now()));
			}
			return true;
		} catch {
			this.recordSnapshotFailure(captureRootGroup);
			return false;
		}
	}
	recordSnapshotFailure(captureRootGroup) {
		if (isChildProcessRunning(this.child)) {
			this.failedRootObservation = true;
			return;
		}
		if (captureRootGroup) this.unresolvedOwnership = true;
		this.captureGroupAfterExit = false;
	}
	requiredSnapshotPids(rootWasRunning) {
		return [...this.identities.keys(), ...rootWasRunning && this.child.pid ? [this.child.pid] : []];
	}
	refresh(table, rootWasRunning) {
		this.verifyScope(table);
		const owned = /* @__PURE__ */ new Set();
		for (const [pid, identity] of this.identities) {
			const observed = table.get(pid);
			if (observed && compareProcessBirthIdentity(identity.birth, observed.birth) === "matching") owned.add(pid);
		}
		this.includeRoot(table, owned);
		if (owned.has(this.child.pid ?? 0)) {
			this.failedRootObservation = false;
			this.unresolvedOwnership = false;
		}
		if (this.ownProcessGroup) this.includeProcessGroup(table, owned, rootWasRunning);
		includeProcessDescendants(table, owned);
		owned.delete(this.child.pid ?? 0);
		this.identities = new Map([...table].filter(([pid]) => owned.has(pid)));
	}
	verifyScope(table) {
		const expected = this.rootBirth ?? this.identities.values().next().value?.birth;
		const observation = table.values().next().value?.birth;
		if (expected && observation && compareProcessBirthIdentity(expected, observation) === "unknown") throw new Error("Descendant process scope changed");
	}
	includeRoot(table, owned) {
		const root = this.child.pid;
		const rootIdentity = root && table.get(root);
		if (rootIdentity && isChildProcessRunning(this.child)) {
			this.rootBirth ??= rootIdentity.birth;
			if (compareProcessBirthIdentity(this.rootBirth, rootIdentity.birth) === "matching") owned.add(rootIdentity.pid);
		}
	}
	includeProcessGroup(table, owned, rootWasRunning) {
		const root = this.child.pid;
		if (!root || !(rootWasRunning || [...owned].some((pid) => table.get(pid)?.groupPid === root))) return;
		this.unresolvedOwnership = !this.admitGroupMembers(table, owned, root);
		if (!this.unresolvedOwnership) this.failedRootObservation = false;
	}
	admitGroupMembers(table, owned, groupPid) {
		let verified = true;
		for (const identity of table.values()) {
			if (identity.groupPid !== groupPid) continue;
			const beforeExit = this.startedBeforeRootExit(identity);
			if (beforeExit === void 0) verified = false;
			else if (beforeExit) owned.add(identity.pid);
		}
		return verified;
	}
	startedBeforeRootExit(identity) {
		const cutoff = this.groupExitedAt;
		if (cutoff === void 0) return true;
		if (cutoff === null) return;
		if (identity.birth.kind !== "linux-proc") return typeof cutoff === "number" ? Date.parse(identity.birth.value) <= cutoff : void 0;
		if (typeof cutoff === "number" || identity.birth.timeNamespace !== cutoff.timeNamespace || !identity.clockTicksPerSecond) return;
		return BigInt(identity.birth.startTicks) * 100n < (cutoff.centiseconds + 1n) * identity.clockTicksPerSecond;
	}
	async signal(signal, timeoutMs) {
		if (!await this.capture(timeoutMs) || this.retired) return;
		for (const pid of this.identities.keys()) try {
			process.kill(pid, signal);
		} catch {}
	}
	hasTrackedProcesses() {
		return this.identities.size > 0;
	}
	hasUnresolvedOwnership() {
		return this.unresolvedOwnership || !this.ownProcessGroup && this.failedRootObservation && !isChildProcessRunning(this.child);
	}
	async waitForExit(timeoutMs) {
		const deadline = performance.now() + timeoutMs;
		do {
			if (!await this.capture(Math.max(1, deadline - performance.now()))) return false;
			if (this.identities.size === 0) return true;
			await setTimeout$1(Math.min(100, Math.max(0, deadline - performance.now())));
		} while (performance.now() < deadline);
		return false;
	}
	retire() {
		this.retired = true;
		this.child.off("exit", this.onRootExit);
		this.identities.clear();
	}
};
// src/session/queue/paths.ts
function shortHash(value, length) {
	return createHash("sha256").update(value).digest("hex").slice(0, length);
}
function queueKeyForSession(sessionId) {
	return shortHash(sessionId, 24);
}
function queueBaseDir(homeDir = os.homedir()) {
	return path.join(homeDir, ".acpx", "queues");
}
function queueSocketBaseDir(homeDir = os.homedir()) {
	if (process.platform === "win32") return;
	return path.join("/tmp", `acpx-${shortHash(homeDir, 10)}`);
}
function queueLockFilePath(sessionId, homeDir = os.homedir()) {
	return path.join(queueBaseDir(homeDir), `${queueKeyForSession(sessionId)}.lock`);
}
function queueSocketPath(sessionId, homeDir = os.homedir()) {
	const key = queueKeyForSession(sessionId);
	if (process.platform === "win32") return `\\\\.\\pipe\\acpx-${key}`;
	return path.join(queueSocketBaseDir(homeDir) ?? "/tmp", `${key}.sock`);
}
// src/session/queue/retirement-receipt.ts
const MAX_RETIREMENT_MEMBERS = 4096;
const MAX_RETIREMENT_BYTES = 1048576;
function hasQueueRetirementReceipt(value) {
	return value !== null && typeof value === "object" && Object.hasOwn(value, "retirement");
}
function parseWitness(raw) {
	if (!raw || typeof raw !== "object") return;
	const value = raw;
	const processIdentity = parseProcessBirthIdentity(value.processIdentity);
	if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 1 || processIdentity?.kind !== "windows-creation") return;
	return {
		pid: value.pid,
		processIdentity
	};
}
function parseQueueRetirementReceipt(raw, owner) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const value = raw;
	const root = parseReceiptRoot(value, owner);
	if (!root) return null;
	const descendants = parseDescendants(value.descendants, root.pid);
	if (!descendants) return null;
	try {
		if (Buffer.byteLength(JSON.stringify(raw)) > MAX_RETIREMENT_BYTES) return null;
	} catch {
		return null;
	}
	return {
		ownerGeneration: owner.ownerGeneration,
		root,
		descendants
	};
}
function parseReceiptRoot(value, owner) {
	const root = parseWitness(value.root);
	if (!root || root.pid !== owner.pid || value.ownerGeneration !== owner.ownerGeneration || compareProcessBirthIdentity(owner.processIdentity, root.processIdentity) !== "matching") return;
	return root;
}
function parseDescendants(raw, rootPid) {
	if (!Array.isArray(raw) || raw.length >= MAX_RETIREMENT_MEMBERS) return;
	const pids = /* @__PURE__ */ new Set([rootPid]);
	const witnesses = [];
	for (const value of raw) {
		const witness = parseWitness(value);
		if (!witness || pids.has(witness.pid)) return;
		pids.add(witness.pid);
		witnesses.push(witness);
	}
	return witnesses;
}
function queueRetirementIncomplete() {
	return new QueueConnectionError("Queue-owner descendant cleanup is incomplete or unverified. Its lease was retained. Retry cleanup with updated clients and process-query access; do not remove the lease while recorded processes may remain.", {
		detailCode: "QUEUE_OWNER_RETIREMENT_INCOMPLETE",
		origin: "queue",
		retryable: true
	});
}
function retirementTimeRemaining(deadline, maximumMs = 2e3) {
	const remaining = deadline - performance.now();
	if (remaining <= 0) throw queueRetirementIncomplete();
	return Math.min(maximumMs, remaining);
}
async function readRetirementSnapshot(deadline) {
	if (process.platform !== "win32") throw queueRetirementIncomplete();
	return await readProcessTable(retirementTimeRemaining(deadline)).catch(() => {
		throw queueRetirementIncomplete();
	});
}
function observeRetirementSnapshot(witness, table) {
	if (process.platform !== "win32" || !isWindowsRetirementIdentity(witness.processIdentity)) return "unknown";
	const observed = table?.get(witness.pid);
	const comparison = observed ? compareProcessBirthIdentity(witness.processIdentity, observed.birth) : "unknown";
	if (comparison === "different" || isProcessDefinitelyDead(witness.pid)) return "gone";
	return witness.pid === process.pid ? "unknown" : comparison;
}
function isWindowsRetirementIdentity(identity) {
	return identity === void 0 || identity.kind === "windows-creation";
}
function captureQueueRetirementReceipt(owner, previous, rootRunning, snapshot) {
	const root = parseWitness({
		pid: owner.pid,
		processIdentity: owner.processIdentity
	});
	if (!root || process.platform !== "win32") throw queueRetirementIncomplete();
	const saved = previous ? previous.descendants : [];
	const table = new Map(snapshot);
	const owned = matchingSnapshotPids(table, rootRunning ? [root, ...saved] : saved);
	if (rootRunning && !owned.has(root.pid)) throw queueRetirementIncomplete();
	table.delete(1);
	table.delete(process.pid);
	includeProcessDescendants(table, owned);
	owned.delete(root.pid);
	const receipt = {
		ownerGeneration: owner.ownerGeneration,
		root,
		descendants: unsettledSnapshotWitnesses(snapshot, mergeSnapshotDescendants(table, owned, saved))
	};
	if (!parseQueueRetirementReceipt(receipt, owner)) throw queueRetirementIncomplete();
	return receipt;
}
function unsettledSnapshotWitnesses(table, witnesses) {
	return witnesses.filter((witness) => {
		const observed = table.get(witness.pid);
		return !observed || compareProcessBirthIdentity(witness.processIdentity, observed.birth) !== "different";
	});
}
function matchingSnapshotPids(table, witnesses) {
	const owned = /* @__PURE__ */ new Set();
	for (const witness of witnesses) {
		const observed = table.get(witness.pid);
		if (observed && compareProcessBirthIdentity(witness.processIdentity, observed.birth) === "matching") owned.add(witness.pid);
	}
	return owned;
}
function mergeSnapshotDescendants(table, owned, saved) {
	const descendants = new Map(saved.map((witness) => [witness.pid, witness]));
	for (const pid of owned) {
		const observed = table.get(pid);
		if (observed) descendants.set(pid, {
			pid,
			processIdentity: observed.birth
		});
	}
	return [...descendants.values()];
}
async function observeRetirementWitness(witness, deadline) {
	if (witness.pid === process.pid) throw queueRetirementIncomplete();
	return await observeProcessIncarnation(witness.pid, witness.processIdentity, retirementTimeRemaining(deadline));
}
async function assertQueueRetirementComplete(receipt, deadline) {
	if (receipt === null) throw queueRetirementIncomplete();
	const witnesses = receipt?.descendants ?? [];
	if (witnesses.length === 0) return;
	const live = witnesses.filter((witness) => observeRetirementSnapshot(witness, void 0) !== "gone");
	const table = live.length > 0 ? await readRetirementSnapshot(deadline) : void 0;
	for (const witness of live) if (observeRetirementSnapshot(witness, table) !== "gone") throw queueRetirementIncomplete();
}
// src/session/queue/lease-mutation.ts
const GUARD_WAIT_MS = 2e3;
const localMutations = /* @__PURE__ */ new Map();
var QueueLeaseGuardSettlementError = class extends QueueConnectionError {
	constructor(errors) {
		super("Queue lease guard settlement failed; cleanup remains retryable", {
			detailCode: "QUEUE_LEASE_GUARD_SETTLEMENT_FAILED",
			origin: "queue",
			retryable: false,
			cause: new AggregateError(errors, "Queue lease mutation and settlement errors")
		});
	}
};
async function canonicalLeasePath(sessionId) {
	const requested = queueLockFilePath(sessionId);
	try {
		return path.join(await fs$1.realpath(path.dirname(requested)), path.basename(requested));
	} catch (error) {
		if (error.code === "ENOENT") return path.resolve(requested);
		throw error;
	}
}
async function acquireGuard(lockPath, owner) {
	return await acquireFileLock(lockPath, {
		managerKey: "acpx.queue-lease-mutation",
		lockPath: `${lockPath}.guard`,
		staleMs: Infinity,
		timeoutMs: GUARD_WAIT_MS,
		retry: {
			minTimeout: 5,
			maxTimeout: 15,
			factor: 1,
			randomize: false
		},
		staleRecovery: "remove-if-unchanged",
		payload: () => owner.payload,
		shouldReclaim: ({ payload }) => owner.hasExited(payload),
		shouldRemoveStaleLock: ({ payload }) => owner.hasExited(payload, true)
	});
}
function matchesReservation(value, expected) {
	if (!value || typeof value !== "object") return false;
	const record = value;
	return record.pid === expected.pid && record.sessionId === expected.sessionId && record.ownerGeneration === expected.ownerGeneration;
}
async function rollbackReservation(lockPath, expected) {
	try {
		if (!(await fs$1.lstat(lockPath)).isFile()) return;
		const raw = await fs$1.readFile(lockPath, "utf8");
		let value;
		try {
			value = JSON.parse(raw);
		} catch {
			return;
		}
		if (matchesReservation(value, expected) && !hasQueueRetirementReceipt(value)) await fs$1.unlink(lockPath);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}
async function settleReceipt(lockPath, receipt) {
	if (receipt.reservation) {
		if (!await receipt.guard.verifyStillHeld()) {
			await receipt.guard.release();
			receipt.guard = await acquireGuard(lockPath, receipt.owner);
		}
		await rollbackReservation(lockPath, receipt.reservation);
		receipt.reservation = void 0;
	}
	await receipt.guard.release();
}
async function settleFailedGuard(lockPath, state) {
	const failed = state.failed;
	if (!failed) return;
	try {
		await settleReceipt(lockPath, failed);
		if (state.failed === failed) state.failed = void 0;
	} catch (error) {
		throw new QueueLeaseGuardSettlementError([error]);
	}
}
async function locallySerialized(lockPath, run) {
	let state = localMutations.get(lockPath);
	if (!state) {
		state = { tail: Promise.resolve() };
		localMutations.set(lockPath, state);
	}
	const current = state;
	const operation = current.tail.then(async () => await run(current));
	const tail = operation.then(() => {}, () => {});
	current.tail = tail;
	try {
		return await operation;
	} finally {
		if (current.tail === tail && !current.failed && localMutations.get(lockPath) === current) localMutations.delete(lockPath);
	}
}
async function settlePendingQueueLeaseGuard(sessionId) {
	if (localMutations.size === 0) return;
	const lockPath = await canonicalLeasePath(sessionId);
	if (!localMutations.has(lockPath)) return;
	await locallySerialized(lockPath, async (state) => await settleFailedGuard(lockPath, state));
}
async function withQueueLeaseMutation(sessionId, mutate, options = {}) {
	const { reservation, capturedIdentity } = options;
	await fs$1.mkdir(path.dirname(queueLockFilePath(sessionId)), {
		recursive: true,
		mode: 448
	});
	const lockPath = await canonicalLeasePath(sessionId);
	const expected = reservation ? {
		pid: reservation.pid,
		sessionId: reservation.sessionId,
		ownerGeneration: reservation.ownerGeneration
	} : void 0;
	const publishedReservation = () => reservation?.published ? expected : void 0;
	return await locallySerialized(lockPath, async (state) => {
		await settleFailedGuard(lockPath, state);
		const owner = await createLockOwner({ capturedIdentity });
		const guard = await acquireGuard(lockPath, owner);
		let outcome;
		try {
			outcome = {
				ok: true,
				value: await mutate()
			};
		} catch (error) {
			outcome = {
				ok: false,
				error
			};
		}
		const published = publishedReservation();
		const receipt = {
			guard,
			owner,
			reservation: outcome.ok ? void 0 : published
		};
		try {
			await settleReceipt(lockPath, receipt);
		} catch (error) {
			if (outcome.ok) receipt.reservation = published;
			state.failed = receipt;
			throw new QueueLeaseGuardSettlementError(outcome.ok ? [error] : [outcome.error, error]);
		}
		if (!outcome.ok) throw outcome.error;
		return outcome.value;
	});
}
// src/session/queue/lease-store.ts
const PROCESS_SIGTERM_GRACE_MS = process.platform === "win32" ? 4e3 : 12e3;
const PROCESS_SIGKILL_GRACE_MS = 1500;
const PROCESS_POLL_MS = 50;
const QUEUE_OWNER_STALE_HEARTBEAT_MS = 15e3;
function parseQueueOwnerRecord(raw) {
	if (!raw || typeof raw !== "object") return null;
	const record = raw;
	if (!hasValidQueueOwnerRecordFields(record)) return null;
	const processIdentity = parseProcessBirthIdentity(record.processIdentity);
	const owner = {
		pid: record.pid,
		sessionId: record.sessionId,
		socketPath: record.socketPath,
		createdAt: record.createdAt,
		heartbeatAt: record.heartbeatAt,
		ownerGeneration: record.ownerGeneration,
		queueDepth: record.queueDepth,
		...processIdentity ? { processIdentity } : {},
		...parseQueueOwnerCapabilities(record),
		...typeof record.mcpConfigPath === "string" ? { mcpConfigPath: record.mcpConfigPath } : {},
		...typeof record.mcpConfigFingerprint === "string" ? { mcpConfigFingerprint: record.mcpConfigFingerprint } : {}
	};
	if (hasQueueRetirementReceipt(record)) owner.retirement = parseQueueRetirementReceipt(record.retirement, owner);
	return owner;
}
function parseQueueOwnerCapabilities(record) {
	return {
		...record.sharedRuntime === true ? { sharedRuntime: true } : {},
		...record.sessionWatch === true ? { sessionWatch: true } : {},
		...record.persistsControlState === true ? { persistsControlState: true } : {}
	};
}
function hasValidQueueOwnerRecordFields(record) {
	return !Array.isArray(record) && isPositiveInteger(record.pid) && typeof record.sessionId === "string" && typeof record.socketPath === "string" && typeof record.createdAt === "string" && typeof record.heartbeatAt === "string" && isPositiveInteger(record.ownerGeneration) && isNonNegativeInteger(record.queueDepth);
}
function isPositiveInteger(value) {
	return Number.isInteger(value) && value > 0;
}
function isNonNegativeInteger(value) {
	return Number.isInteger(value) && value >= 0;
}
function createOwnerGeneration() {
	return randomInt(1, 2 ** 48);
}
function nowIso() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function isQueueOwnerHeartbeatStale(owner) {
	const heartbeatMs = Date.parse(owner.heartbeatAt);
	if (!Number.isFinite(heartbeatMs)) return true;
	return Date.now() - heartbeatMs > QUEUE_OWNER_STALE_HEARTBEAT_MS;
}
async function ensureQueueDir() {
	const baseDir = queueBaseDir();
	try {
		await fs$1.mkdir(baseDir, {
			recursive: true,
			mode: 448
		});
		await fs$1.chmod(baseDir, 448);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to prepare queue directory ${baseDir}: ${message}`, { cause: error });
	}
	const socketDir = queueSocketBaseDir();
	if (socketDir) try {
		await fs$1.mkdir(socketDir, {
			recursive: true,
			mode: 448
		});
		await fs$1.chmod(socketDir, 448);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to prepare queue socket directory ${socketDir}: ${message}`, { cause: error });
	}
}
async function removeSocketFile(socketPath) {
	if (process.platform === "win32") return;
	try {
		await fs$1.unlink(socketPath);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}
async function waitForProcessExit(pid, timeoutMs, hasExited) {
	const deadline = performance.now() + Math.max(0, timeoutMs);
	while (performance.now() <= deadline) {
		if (hasExited(pid)) return true;
		await waitMs(PROCESS_POLL_MS);
	}
	return hasExited(pid);
}
async function cleanupQueueOwnerFiles(sessionId, socketPath, isCurrent, capturedIdentity, deadline = retirementDeadline()) {
	await withQueueLeaseMutation(sessionId, async () => {
		await cleanupGuardedQueueOwnerFiles(sessionId, socketPath, isCurrent, deadline);
	}, { capturedIdentity });
}
async function cleanupGuardedQueueOwnerFiles(sessionId, socketPath, isCurrent, deadline = retirementDeadline()) {
	if (!await isCurrent()) return;
	await assertQueueRetirementComplete((await readQueueOwnerRecord(sessionId))?.retirement, deadline);
	await removeSocketFile(socketPath).catch(() => {});
	if (!await isCurrent()) return;
	await fs$1.unlink(queueLockFilePath(sessionId)).catch((error) => {
		if (error.code !== "ENOENT") throw error;
	});
}
async function ownsQueueLease(owner) {
	return matchesQueueOwner(await readQueueOwnerRecord(owner.sessionId), owner);
}
function matchesQueueOwner(current, expected) {
	return current?.sessionId === expected.sessionId && current.pid === expected.pid && current.ownerGeneration === expected.ownerGeneration;
}
function ownerIsAlive(owner) {
	return owner.pid === process.pid || isProcessAlive(owner.pid);
}
function ownerAcceptsWork(owner) {
	return owner.retirement === void 0 && ownerIsAlive(owner) && !isQueueOwnerHeartbeatStale(owner);
}
async function readQueueOwnerRecord(sessionId) {
	const lockPath = queueLockFilePath(sessionId);
	try {
		const payload = await fs$1.readFile(lockPath, "utf8");
		const parsed = parseQueueOwnerRecord(JSON.parse(payload));
		return parsed?.sessionId === sessionId ? parsed : void 0;
	} catch {
		return;
	}
}
async function terminateProcess(pid, beforeSignal) {
	if (!isProcessAlive(pid)) return false;
	return await terminateWithDispatch(pid, async (signal) => {
		if (beforeSignal && !await beforeSignal(signal)) return false;
		return dispatchSignal(pid, signal);
	}, (target) => !isProcessAlive(target));
}
function dispatchSignal(pid, signal) {
	try {
		process.kill(pid, signal);
		return true;
	} catch {
		return false;
	}
}
async function dispatchQueueOwnerSignal(pid, signal, deadline) {
	if (process.platform !== "win32") return dispatchSignal(pid, signal);
	const systemRoot = process.env.SystemRoot;
	if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error("Windows queue-owner cleanup requires an absolute SystemRoot directory");
	const taskkill = path.win32.join(systemRoot, "System32", "taskkill.exe");
	await runTimedExecFile(taskkill, [
		"/pid",
		String(pid),
		"/T",
		"/F"
	], {
		timeoutMs: retirementTimeRemaining(deadline, PROCESS_SIGTERM_GRACE_MS),
		windowsHide: true
	});
	return true;
}
async function terminateWithDispatch(pid, dispatch, hasExited, deadline = Infinity) {
	for (const [signal, graceMs] of [["SIGTERM", PROCESS_SIGTERM_GRACE_MS], ["SIGKILL", PROCESS_SIGKILL_GRACE_MS]]) {
		if (!await dispatch(signal)) return false;
		if (await waitForProcessExit(pid, Math.min(graceMs, deadline - performance.now()), hasExited)) return true;
	}
	return false;
}
async function resolveUsableQueueOwner(sessionId, owner) {
	await settlePendingQueueLeaseGuard(sessionId);
	const observed = await readQueueOwnerRecord(sessionId);
	if (!matchesQueueOwner(observed, owner)) return;
	if (ownerAcceptsWork(observed)) return observed;
	await terminateQueueOwnerForSession(sessionId, observed, true);
	const current = await readQueueOwnerRecord(sessionId);
	return matchesQueueOwner(current, observed) && ownerAcceptsWork(current) ? current : void 0;
}
async function tryAcquireQueueOwnerLease(sessionId, mcpConfigOrNowIsoFactory, nowIsoFactory = nowIso) {
	const { mcpConfigPath, clock } = resolveLeaseArguments(mcpConfigOrNowIsoFactory, nowIsoFactory);
	const mcpConfigMetadata = createMcpConfigMetadata(mcpConfigPath, readMcpConfigFingerprint(mcpConfigOrNowIsoFactory));
	const processIdentity = await getOwnProcessIdentity();
	await ensureQueueDir();
	const lockPath = queueLockFilePath(sessionId);
	const socketPath = queueSocketPath(sessionId);
	const createdAt = clock();
	const ownerGeneration = createOwnerGeneration();
	const lease = {
		pid: process.pid,
		sessionId,
		lockPath,
		socketPath,
		createdAt,
		ownerGeneration,
		...processIdentity ? { processIdentity } : {},
		...mcpConfigMetadata,
		updates: Promise.resolve(),
		released: false
	};
	const reservation = {
		pid: lease.pid,
		sessionId,
		ownerGeneration,
		published: false
	};
	try {
		return await withQueueLeaseMutation(sessionId, async () => {
			await stageQueueOwnerRecord(lease, 0, clock, async (tempPath, payload) => {
				try {
					await fs$1.link(tempPath, lockPath);
				} catch (error) {
					if (!isHardlinkFallbackError(error)) throw error;
					await fs$1.writeFile(lockPath, payload, {
						encoding: "utf8",
						flag: "wx",
						mode: 384
					});
				}
				reservation.published = true;
			});
			await removeSocketFile(socketPath).catch(() => {});
			return lease;
		}, {
			reservation,
			capturedIdentity: lease
		});
	} catch (error) {
		return await handleLeaseCollision(sessionId, error);
	}
}
function readMcpConfigFingerprint(mcpConfigOrNowIsoFactory) {
	return typeof mcpConfigOrNowIsoFactory === "object" ? mcpConfigOrNowIsoFactory?.fingerprint : void 0;
}
function createMcpConfigMetadata(mcpConfigPath, mcpConfigFingerprint) {
	return {
		...mcpConfigPath ? { mcpConfigPath } : {},
		...mcpConfigFingerprint ? { mcpConfigFingerprint } : {}
	};
}
async function handleLeaseCollision(sessionId, error) {
	if (error.code !== "EEXIST") throw error;
	const owner = await readQueueOwnerRecord(sessionId);
	if (!owner) {
		await cleanupAbandonedReservation(sessionId);
		return;
	}
	await resolveUsableQueueOwner(sessionId, owner);
}
async function cleanupAbandonedReservation(sessionId) {
	const lockPath = queueLockFilePath(sessionId);
	await withQueueLeaseMutation(sessionId, async () => {
		try {
			const observed = await fs$1.lstat(lockPath, { bigint: true });
			if (!observed.isFile() || Date.now() - Number(observed.mtimeMs) <= QUEUE_OWNER_STALE_HEARTBEAT_MS) return;
			const raw = await fs$1.readFile(lockPath, "utf8");
			if (await readQueueOwnerRecord(sessionId)) return;
			await cleanupGuardedQueueOwnerFiles(sessionId, queueSocketPath(sessionId), async () => {
				const current = await fs$1.lstat(lockPath, { bigint: true });
				return current.isFile() && current.dev === observed.dev && current.ino === observed.ino && current.mtimeNs === observed.mtimeNs && await fs$1.readFile(lockPath, "utf8") === raw;
			});
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	});
}
function resolveLeaseArguments(mcpConfigOrNowIsoFactory, nowIsoFactory) {
	if (typeof mcpConfigOrNowIsoFactory === "string") return {
		mcpConfigPath: mcpConfigOrNowIsoFactory,
		clock: nowIsoFactory
	};
	if (typeof mcpConfigOrNowIsoFactory === "function") return {
		mcpConfigPath: void 0,
		clock: mcpConfigOrNowIsoFactory
	};
	if (mcpConfigOrNowIsoFactory) return {
		mcpConfigPath: mcpConfigOrNowIsoFactory.path,
		clock: nowIsoFactory
	};
	return {
		mcpConfigPath: void 0,
		clock: nowIsoFactory
	};
}
function refreshQueueOwnerLease(lease, options, nowIsoFactory = nowIso) {
	if (lease.released) return Promise.resolve();
	const update = lease.updates.then(async () => {
		await withQueueLeaseMutation(lease.sessionId, async () => {
			const current = await readQueueOwnerRecord(lease.sessionId);
			if (!matchesQueueOwner(current, lease)) return;
			if (current.retirement === null) throw queueRetirementIncomplete();
			await replaceQueueOwnerRecord({
				...current,
				heartbeatAt: nowIsoFactory(),
				queueDepth: Math.max(0, Math.round(options.queueDepth))
			});
		}, { capturedIdentity: lease });
	});
	lease.updates = update.catch(() => {});
	return update;
}
async function stageQueueOwnerRecord(lease, queueDepth, clock, publish) {
	await stagePreparedQueueOwnerRecord({
		pid: lease.pid,
		sessionId: lease.sessionId,
		socketPath: lease.socketPath,
		createdAt: lease.createdAt,
		heartbeatAt: clock(),
		ownerGeneration: lease.ownerGeneration,
		...lease.processIdentity ? { processIdentity: lease.processIdentity } : {},
		queueDepth: Math.max(0, Math.round(queueDepth)),
		sharedRuntime: true,
		sessionWatch: true,
		persistsControlState: true,
		...lease.mcpConfigPath ? { mcpConfigPath: lease.mcpConfigPath } : {},
		...lease.mcpConfigFingerprint ? { mcpConfigFingerprint: lease.mcpConfigFingerprint } : {}
	}, publish);
}
async function replaceQueueOwnerRecord(owner) {
	await stagePreparedQueueOwnerRecord(owner, async (tempPath) => {
		await fs$1.rename(tempPath, queueLockFilePath(owner.sessionId));
	});
}
async function stagePreparedQueueOwnerRecord(owner, publish) {
	const payload = JSON.stringify(owner, null, 2);
	await withTempFile({
		rootDir: path.dirname(queueLockFilePath(owner.sessionId)),
		prefix: "owner",
		fileName: "lease"
	}, async (tempPath) => {
		await fs$1.writeFile(tempPath, `${payload}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 384
		});
		await publish(tempPath, `${payload}\n`);
	});
}
async function releaseQueueOwnerLease(lease) {
	lease.released = true;
	await lease.updates;
	await cleanupQueueOwnerFiles(lease.sessionId, lease.socketPath, () => ownsQueueLease(lease), lease);
}
function unverifiedQueueOwnerError(owner) {
	return new QueueConnectionError(`Cannot safely retire queue owner pid ${owner.pid}: its process birth identity is unverified. Its lease was retained. Retry from the same local process namespace with process-query access, or let the owner finish normal shutdown or idle expiry.`, {
		detailCode: "QUEUE_OWNER_IDENTITY_UNVERIFIED",
		origin: "queue",
		retryable: true
	});
}
function retirementDeadline() {
	return performance.now() + PROCESS_SIGTERM_GRACE_MS + PROCESS_SIGKILL_GRACE_MS;
}
async function createQueueOwnerRetirement(deadline) {
	const snapshot = process.platform === "win32" ? await readRetirementSnapshot(deadline).catch(() => void 0) : void 0;
	return {
		gone: false,
		unverified: false,
		leaseReleased: false,
		deadline,
		snapshot,
		capturedIdentity: process.platform === "win32" ? { processIdentity: snapshot?.get(process.pid)?.birth } : void 0
	};
}
async function observeRetiringOwner(owner, deadline) {
	return await observeProcessIncarnation(owner.pid, owner.processIdentity, process.platform === "win32" ? retirementTimeRemaining(deadline) : void 0);
}
function retirementBlockedByHeartbeat(owner, signal, requireStale) {
	return requireStale && owner.retirement === void 0 && signal === "SIGTERM" && !isQueueOwnerHeartbeatStale(owner);
}
async function prepareWindowsRetirement(owner, table, deadline) {
	if (owner.retirement === null || !table) throw queueRetirementIncomplete();
	owner.retirement = captureQueueRetirementReceipt(owner, owner.retirement, true, table);
	await replaceQueueOwnerRecord(owner);
	return await observeRetirementWitness(owner.retirement.root, deadline);
}
async function prepareRetiringOwner(owner, signal, retirement) {
	const windows = process.platform === "win32";
	const table = windows && signal !== "SIGTERM" ? await readRetirementSnapshot(retirement.deadline) : retirement.snapshot;
	let identity = windows ? observeRetirementSnapshot(owner, table) : await observeRetiringOwner(owner, retirement.deadline);
	if (identity === "matching" && windows) identity = await prepareWindowsRetirement(owner, table, retirement.deadline);
	retirement.gone = identity === "gone";
	retirement.unverified = identity === "unknown";
	return identity === "matching";
}
async function dispatchVerifiedQueueOwnerSignal(owner, signal, requireStale, retirement) {
	return await withQueueLeaseMutation(owner.sessionId, async () => {
		const current = await readQueueOwnerRecord(owner.sessionId);
		retirement.leaseReleased = current?.pid !== owner.pid;
		if (!matchesQueueOwner(current, owner) || retirementBlockedByHeartbeat(current, signal, requireStale)) return false;
		if (current.retirement === null) throw queueRetirementIncomplete();
		if (!await prepareRetiringOwner(current, signal, retirement)) return false;
		return await dispatchQueueOwnerSignal(owner.pid, signal, retirement.deadline);
	}, { capturedIdentity: retirement.capturedIdentity });
}
async function retireQueueOwner(owner, requireStale, retirement) {
	const { deadline } = retirement;
	const exited = await terminateWithDispatch(owner.pid, (signal) => dispatchVerifiedQueueOwnerSignal(owner, signal, requireStale, retirement), isProcessDefinitelyDead, process.platform === "win32" ? deadline : Infinity);
	if (await waitForReleasedOwner(owner, requireStale, retirement)) return false;
	const gone = retirement.gone || process.platform === "win32" && exited || await observeRetiringOwner(owner, deadline) === "gone";
	if (retirement.unverified && !gone) throw unverifiedQueueOwnerError(owner);
	return gone;
}
async function waitForReleasedOwner(owner, requireStale, retirement) {
	if (retirement.unverified && requireStale) throw unverifiedQueueOwnerError(owner);
	if (retirement.leaseReleased || retirement.unverified) {
		await waitForProcessExit(owner.pid, Math.max(0, retirement.deadline - performance.now()), isProcessDefinitelyDead);
		if (performance.now() >= retirement.deadline) {
			if (retirement.unverified) throw unverifiedQueueOwnerError(owner);
			return true;
		}
	}
	return false;
}
async function retireRecordedDescendants(owner, retirement) {
	await withQueueLeaseMutation(owner.sessionId, async () => {
		const current = await readQueueOwnerRecord(owner.sessionId);
		if (!matchesQueueOwner(current, owner) || current.retirement === void 0) return;
		if (current.retirement === null || process.platform !== "win32") throw queueRetirementIncomplete();
		await retireSnapshotDescendants(current, current.retirement, retirement.deadline);
	}, { capturedIdentity: retirement.capturedIdentity });
}
function hasNewRetirementWitness(previous, receipt) {
	const saved = new Map(previous.descendants.map((witness) => [witness.pid, witness.processIdentity]));
	return receipt.descendants.some((witness) => compareProcessBirthIdentity(saved.get(witness.pid), witness.processIdentity) !== "matching");
}
async function retireSnapshotDescendants(owner, receipt, deadline) {
	while (receipt.descendants.length > 0) {
		const table = await readRetirementSnapshot(deadline);
		const discovered = captureQueueRetirementReceipt(owner, receipt, false, table);
		if (hasNewRetirementWitness(receipt, discovered)) {
			receipt = discovered;
			owner.retirement = receipt;
			await replaceQueueOwnerRecord(owner);
			continue;
		}
		signalRecordedDescendants(discovered, table, deadline);
		await waitForRecordedDescendants(discovered, deadline);
		discovered.descendants = discovered.descendants.filter((witness) => !isProcessDefinitelyDead(witness.pid));
		receipt = discovered;
		owner.retirement = receipt;
		await replaceQueueOwnerRecord(owner);
	}
}
function leafFirstRetirementWitnesses(receipt, table) {
	const children = new Map(receipt.descendants.map((witness) => [witness.pid, 0]));
	for (const witness of receipt.descendants) {
		const parent = retirementParent(witness.pid, table);
		const count = children.get(parent);
		if (count !== void 0) children.set(parent, count + 1);
	}
	const pending = receipt.descendants.filter((witness) => children.get(witness.pid) === 0);
	const byPid = new Map(receipt.descendants.map((witness) => [witness.pid, witness]));
	for (let index = 0; index < pending.length; index += 1) {
		const parent = retirementParent(pending[index].pid, table);
		const count = children.get(parent);
		if (count !== void 0) {
			const remaining = count - 1;
			children.set(parent, remaining);
			if (remaining === 0) pending.push(byPid.get(parent));
		}
	}
	if (pending.length !== receipt.descendants.length) throw queueRetirementIncomplete();
	return pending;
}
function retirementParent(pid, table) {
	const identity = table.get(pid);
	return identity && !hasStaleWindowsParent(identity, table.get(identity.parentPid)) ? identity.parentPid : 0;
}
function signalRecordedDescendants(receipt, table, deadline) {
	if (receipt.descendants.some((witness) => observeRetirementSnapshot(witness, table) === "unknown")) throw queueRetirementIncomplete();
	const ordered = leafFirstRetirementWitnesses(receipt, table);
	let failure;
	for (const witness of ordered) {
		if (observeRetirementSnapshot(witness, table) !== "matching") continue;
		retirementTimeRemaining(deadline);
		try {
			process.kill(witness.pid, "SIGKILL");
		} catch (error) {
			if (!isProcessDefinitelyDead(witness.pid)) failure ??= error;
		}
	}
	if (failure) throw failure;
}
async function waitForRecordedDescendants(receipt, deadline) {
	for (let waited = 0; waited < 1e3; waited += PROCESS_POLL_MS) {
		if (receipt.descendants.every((witness) => isProcessDefinitelyDead(witness.pid))) return;
		await waitMs(Math.min(PROCESS_POLL_MS, retirementTimeRemaining(deadline)));
	}
}
async function assertNoPendingRetirement(owner) {
	const current = await readQueueOwnerRecord(owner.sessionId);
	if (matchesQueueOwner(current, owner) && current.retirement !== void 0) throw queueRetirementIncomplete();
}
async function terminateQueueOwnerForSession(sessionId, expectedOwner, requireStale = false) {
	await settlePendingQueueLeaseGuard(sessionId);
	const owner = expectedOwner ?? await readQueueOwnerRecord(sessionId);
	if (!owner || owner.sessionId !== sessionId) return;
	if (owner.pid === process.pid) {
		if (owner.retirement !== void 0) throw queueRetirementIncomplete();
		return;
	}
	const deadline = retirementDeadline();
	const retirement = await createQueueOwnerRetirement(deadline);
	if (!await retireQueueOwner(owner, requireStale, retirement)) {
		await assertNoPendingRetirement(owner);
		return;
	}
	await retireRecordedDescendants(owner, retirement);
	await cleanupQueueOwnerFiles(sessionId, owner.socketPath, () => ownsQueueLease(owner), retirement.capturedIdentity, deadline);
}
async function waitMs(ms) {
	await new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
// src/session/queue/ipc-transport.ts
const QUEUE_CONNECT_ATTEMPTS = 40;
const SOCKET_CONNECTION_TIMEOUT_MS = 5e3;
function shouldRetryQueueConnect(error) {
	const code = error.code;
	return code === "ENOENT" || code === "ECONNREFUSED";
}
async function connectToSocket(socketPath, timeoutMs = SOCKET_CONNECTION_TIMEOUT_MS) {
	return await new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			socket.destroy();
			reject(/* @__PURE__ */ new Error(`Connection to ${socketPath} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		const onConnect = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.off("error", onError);
			resolve(socket);
		};
		const onError = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.off("connect", onConnect);
			reject(error);
		};
		socket.once("connect", onConnect);
		socket.once("error", onError);
	});
}
async function connectToQueueOwner(owner, maxAttempts = QUEUE_CONNECT_ATTEMPTS) {
	const attempts = Math.max(1, Math.trunc(maxAttempts));
	for (let attempt = 0; attempt < attempts; attempt += 1) try {
		return await measurePerf("queue.connect", async () => await connectToSocket(owner.socketPath));
	} catch (error) {
		if (!shouldRetryQueueConnect(error)) throw error;
		await waitMs(50);
	}
}
// src/session/queue/ipc-health.ts
async function isStillCurrent(owner) {
	const current = await readQueueOwnerRecord(owner.sessionId);
	return current?.pid === owner.pid && current.ownerGeneration === owner.ownerGeneration;
}
async function probeQueueOwnerHealth(sessionId) {
	await settlePendingQueueLeaseGuard(sessionId);
	const ownerRecord = await readQueueOwnerRecord(sessionId);
	if (!ownerRecord) return {
		sessionId,
		hasLease: false,
		healthy: false,
		socketReachable: false,
		pidAlive: false
	};
	const owner = await resolveUsableQueueOwner(sessionId, ownerRecord);
	if (!owner) return {
		sessionId,
		hasLease: false,
		healthy: false,
		socketReachable: false,
		pidAlive: false
	};
	let socketReachable = false;
	try {
		const socket = await connectToQueueOwner(owner, 2);
		if (socket) {
			socketReachable = true;
			if (!socket.destroyed) socket.end();
		}
	} catch {
		socketReachable = false;
	}
	if (!await isStillCurrent(owner)) return {
		sessionId,
		hasLease: false,
		healthy: false,
		socketReachable: false,
		pidAlive: false
	};
	return {
		sessionId,
		hasLease: true,
		healthy: socketReachable,
		socketReachable,
		pidAlive: true,
		pid: owner.pid,
		socketPath: owner.socketPath,
		ownerGeneration: owner.ownerGeneration,
		queueDepth: owner.queueDepth
	};
}
// src/session/queue/messages.ts
function asRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function isPermissionMode(value) {
	return value === "approve-all" || value === "approve-reads" || value === "deny-all";
}
function isSessionResumePolicy(value) {
	return value === "allow-new" || value === "same-session-only";
}
function isNonInteractivePermissionPolicy(value) {
	return value === "deny" || value === "fail";
}
function isPermissionPolicy(value) {
	const record = asRecord(value);
	if (!record) return false;
	return hasValidPermissionRuleLists(record) && hasValidPermissionDefaultAction(record);
}
function hasValidPermissionRuleLists(record) {
	for (const key of [
		"autoApprove",
		"autoDeny",
		"escalate"
	]) if (!isOptionalStringList(record[key])) return false;
	return true;
}
function isOptionalStringList(value) {
	return value == null || Array.isArray(value) && value.every((item) => typeof item === "string");
}
function hasValidPermissionDefaultAction(record) {
	return record.defaultAction == null || record.defaultAction === "approve" || record.defaultAction === "deny" || record.defaultAction === "escalate";
}
function isOutputErrorCode(value) {
	return typeof value === "string" && OUTPUT_ERROR_CODES.includes(value);
}
function isOutputErrorOrigin(value) {
	return typeof value === "string" && OUTPUT_ERROR_ORIGINS.includes(value);
}
function isPermissionEscalationEvent(value) {
	const event = asRecord(value);
	return !!event && hasRequiredPermissionEscalationFields(event) && hasOptionalStringFields(event, [
		"toolName",
		"toolKind",
		"matchedRule"
	]);
}
function hasRequiredPermissionEscalationFields(event) {
	return event.type === "permission_escalation" && typeof event.sessionId === "string" && typeof event.toolCallId === "string" && typeof event.toolTitle === "string" && event.action === "escalate" && typeof event.message === "string" && typeof event.timestamp === "string";
}
function hasOptionalStringFields(record, keys) {
	return keys.every((key) => record[key] == null || typeof record[key] === "string");
}
function parseSessionOptions(value) {
	if (value == null) return;
	const record = asRecord(value);
	if (!record) return null;
	const sessionOptions = {};
	if (!assignSessionModel(sessionOptions, record.model)) return null;
	if (!assignSessionAllowedTools(sessionOptions, record.allowedTools)) return null;
	if (!assignSessionMaxTurns(sessionOptions, record.maxTurns)) return null;
	if (!assignSessionSystemPrompt(sessionOptions, record.systemPrompt)) return null;
	if (!assignSessionEnv(sessionOptions, record.env)) return null;
	return sessionOptions;
}
function assignSessionModel(options, value) {
	if (value == null) return true;
	if (typeof value !== "string" || value.trim().length === 0) return false;
	options.model = value;
	return true;
}
function assignSessionAllowedTools(options, value) {
	if (value == null) return true;
	if (!Array.isArray(value) || value.some((tool) => typeof tool !== "string")) return false;
	options.allowedTools = value;
	return true;
}
function assignSessionMaxTurns(options, value) {
	if (value == null) return true;
	if (typeof value !== "number" || !Number.isFinite(value)) return false;
	options.maxTurns = Math.max(1, Math.round(value));
	return true;
}
function assignSessionSystemPrompt(options, value) {
	if (value == null) return true;
	if (typeof value === "string") {
		options.systemPrompt = value;
		return true;
	}
	const systemPrompt = asRecord(value);
	if (!systemPrompt || typeof systemPrompt.append !== "string") return false;
	options.systemPrompt = { append: systemPrompt.append };
	return true;
}
function assignSessionEnv(options, value) {
	if (value == null) return true;
	const env = asRecord(value);
	if (!env) return false;
	const entries = Object.entries(env);
	if (entries.some(([, entryValue]) => typeof entryValue !== "string")) return false;
	options.env = Object.fromEntries(entries);
	return true;
}
function parseOwnerGeneration(value) {
	if (value == null) return;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
	return value;
}
function parseNonNegativeInteger(value) {
	if (value == null) return;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
	return Math.round(value);
}
function parseQueueRequest(raw) {
	const request = asRecord(raw);
	if (!request || typeof request.type !== "string" || typeof request.requestId !== "string") return null;
	const ownerGeneration = parseOwnerGeneration(request.ownerGeneration);
	if (ownerGeneration === null) return null;
	return parseTypedQueueRequest(request, parseQueueRequestContext(request.requestId, ownerGeneration, request.timeoutMs));
}
function parseQueueRequestContext(requestId, ownerGeneration, timeoutRaw) {
	return {
		requestId,
		ownerGeneration,
		timeoutMs: parsePositiveTimeout(timeoutRaw)
	};
}
function parsePositiveTimeout(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
	return Math.round(value);
}
function parseTypedQueueRequest(request, context) {
	switch (request.type) {
		case "submit_prompt": return parseSubmitRequest(request, context);
		case "cancel_prompt": return parseCancelRequest(request, context);
		case "close_session": return {
			type: "close_session",
			...context
		};
		case "set_mode": return parseStringFieldRequest(request, context, "set_mode", "modeId");
		case "set_model": return parseStringFieldRequest(request, context, "set_model", "modelId");
		case "set_config_option": return parseSetConfigOptionRequest(request, context);
		default: return null;
	}
}
function parseCancelRequest(request, context) {
	if (request.targetRequestId != null && !parseNonEmptyString(request.targetRequestId)) return null;
	return {
		type: "cancel_prompt",
		requestId: context.requestId,
		ownerGeneration: context.ownerGeneration,
		...typeof request.targetRequestId === "string" ? { targetRequestId: request.targetRequestId } : {}
	};
}
function parseSubmitRequest(request, context) {
	const parsed = parseSubmitRequestFields(request);
	if (!parsed) return null;
	return {
		...parsed,
		type: "submit_prompt",
		requestId: context.requestId,
		ownerGeneration: context.ownerGeneration,
		prompt: parsed.prompt ?? textPrompt(parsed.message),
		timeoutMs: context.timeoutMs
	};
}
function parseSubmitRequestFields(request) {
	const parsed = {
		message: typeof request.message === "string" ? request.message : null,
		prompt: parseOptionalValue(request.prompt, isPromptInput),
		permissionMode: parseRequiredValue(request.permissionMode, isPermissionMode),
		resumePolicy: parseOptionalValue(request.resumePolicy, isSessionResumePolicy),
		nonInteractivePermissions: parseOptionalValue(request.nonInteractivePermissions, isNonInteractivePermissionPolicy),
		permissionPolicy: parseOptionalValue(request.permissionPolicy, isPermissionPolicy),
		suppressSdkConsoleErrors: parseOptionalBoolean(request.suppressSdkConsoleErrors),
		promptRetries: parseNonNegativeInteger(request.promptRetries),
		waitForCompletion: typeof request.waitForCompletion === "boolean" ? request.waitForCompletion : null,
		reportPromptStarted: parseOptionalBoolean(request.reportPromptStarted),
		sessionOptions: parseSessionOptions(request.sessionOptions)
	};
	if (Object.values(parsed).some((value) => value === null)) return null;
	for (const key of [
		"resumePolicy",
		"permissionPolicy",
		"suppressSdkConsoleErrors",
		"promptRetries",
		"reportPromptStarted",
		"sessionOptions"
	]) if (parsed[key] === void 0) delete parsed[key];
	return parsed;
}
function parseOptionalValue(value, guard) {
	if (value == null) return;
	return guard(value) ? value : null;
}
function parseRequiredValue(value, guard) {
	return guard(value) ? value : null;
}
function parseOptionalBoolean(value) {
	if (value == null) return;
	return typeof value === "boolean" ? value : null;
}
function parseStringFieldRequest(request, context, type, field) {
	const value = parseNonEmptyString(request[field]);
	if (!value) return null;
	return {
		type,
		...context,
		[field]: value
	};
}
function parseSetConfigOptionRequest(request, context) {
	const configId = parseNonEmptyString(request.configId);
	const value = parseNonEmptyString(request.value);
	if (!configId || !value) return null;
	return {
		type: "set_config_option",
		...context,
		configId,
		value
	};
}
function parseNonEmptyString(value) {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	return value;
}
function parseSessionSendResult(raw) {
	const result = asRecord(raw);
	if (!result || !hasValidSessionSendResultCore(result)) return null;
	const permissionStats = asRecord(result.permissionStats);
	const record = asRecord(result.record);
	if (!permissionStats || !record) return null;
	if (!hasValidPermissionStats(permissionStats)) return null;
	if (!hasValidSessionRecordShape(record)) return null;
	return result;
}
function hasValidSessionSendResultCore(result) {
	return typeof result.stopReason === "string" && typeof result.sessionId === "string" && typeof result.resumed === "boolean" && (result._meta === void 0 || result._meta === null || asRecord(result._meta) !== void 0);
}
function hasValidPermissionStats(permissionStats) {
	return [
		"requested",
		"approved",
		"denied",
		"cancelled"
	].every((key) => typeof permissionStats[key] === "number");
}
function hasValidSessionRecordShape(record) {
	return hasStringFields(record, [
		"acpxRecordId",
		"acpSessionId",
		"agentCommand",
		"cwd",
		"createdAt",
		"lastUsedAt",
		"updated_at"
	]) && Array.isArray(record.messages) && typeof record.lastSeq === "number" && Number.isInteger(record.lastSeq) && !!record.eventLog && typeof record.eventLog === "object";
}
function hasStringFields(record, keys) {
	return keys.every((key) => typeof record[key] === "string");
}
function parseQueueOwnerMessage(raw) {
	const message = asRecord(raw);
	if (!message || typeof message.type !== "string" || typeof message.requestId !== "string") return null;
	const ownerGeneration = parseOwnerGeneration(message.ownerGeneration);
	if (ownerGeneration === null) return null;
	return parseTypedQueueOwnerMessage(message, {
		requestId: message.requestId,
		ownerGeneration
	});
}
function parseTypedQueueOwnerMessage(message, context) {
	const parser = queueOwnerMessageParser(message.type);
	return parser ? parser(message, context) : null;
}
const QUEUE_OWNER_MESSAGE_PARSERS = {
	accepted: (_message, context) => ({
		type: "accepted",
		...context
	}),
	prompt_started: (_message, context) => ({
		type: "prompt_started",
		...context
	}),
	event: parseEventOwnerMessage,
	permission_escalation: parsePermissionEscalationOwnerMessage,
	result: parseResultOwnerMessage,
	cancel_result: (message, context) => parseBooleanResultOwnerMessage(message, context, "cancel_result", "cancelled"),
	close_session_result: (message, context) => parseBooleanResultOwnerMessage(message, context, "close_session_result", "closed"),
	set_mode_result: (message, context) => parseStringResultOwnerMessage(message, context, "set_mode_result", "modeId"),
	set_model_result: parseSetModelOwnerMessage,
	set_config_option_result: parseSetConfigOptionOwnerMessage,
	error: parseErrorOwnerMessage
};
function queueOwnerMessageParser(type) {
	return Object.hasOwn(QUEUE_OWNER_MESSAGE_PARSERS, type) ? QUEUE_OWNER_MESSAGE_PARSERS[type] : void 0;
}
function parseEventOwnerMessage(message, context) {
	if (!isAcpJsonRpcMessage(message.message)) return null;
	const direction = message.direction;
	if (direction !== void 0 && direction !== "inbound" && direction !== "outbound") return null;
	return {
		type: "event",
		...context,
		...direction === void 0 ? {} : { direction },
		message: message.message
	};
}
function parsePermissionEscalationOwnerMessage(message, context) {
	if (!isPermissionEscalationEvent(message.event)) return null;
	return {
		type: "permission_escalation",
		...context,
		event: message.event
	};
}
function parseResultOwnerMessage(message, context) {
	const result = parseSessionSendResult(message.result);
	if (!result) return null;
	return {
		type: "result",
		...context,
		result
	};
}
function parseBooleanResultOwnerMessage(message, context, type, field) {
	if (typeof message[field] !== "boolean") return null;
	return {
		type,
		...context,
		[field]: message[field]
	};
}
function parseStringResultOwnerMessage(message, context, type, field) {
	if (typeof message[field] !== "string") return null;
	return {
		type,
		...context,
		[field]: message[field]
	};
}
function parseSetModelOwnerMessage(message, context) {
	if (typeof message.modelId !== "string") return null;
	const response = asRecord(message.response);
	if (message.response !== void 0 && (!response || response.configOptions !== void 0 && !Array.isArray(response.configOptions))) return null;
	return {
		type: "set_model_result",
		...context,
		modelId: message.modelId,
		...response ? { response } : {}
	};
}
function parseSetConfigOptionOwnerMessage(message, context) {
	const response = asRecord(message.response);
	if (!response || response.configOptions !== void 0 && !Array.isArray(response.configOptions)) return null;
	return {
		type: "set_config_option_result",
		...context,
		response
	};
}
function parseErrorOwnerMessage(message, context) {
	if (!isValidOwnerErrorCore(message)) return null;
	const outputAlreadyEmitted = typeof message.outputAlreadyEmitted === "boolean" ? message.outputAlreadyEmitted : void 0;
	return {
		type: "error",
		...context,
		code: message.code,
		detailCode: parseNonEmptyString(message.detailCode) ?? void 0,
		origin: message.origin,
		message: message.message,
		retryable: typeof message.retryable === "boolean" ? message.retryable : void 0,
		acp: toAcpErrorPayload(message.acp),
		...outputAlreadyEmitted === void 0 ? {} : { outputAlreadyEmitted }
	};
}
function isValidOwnerErrorCore(message) {
	return typeof message.message === "string" && isOutputErrorCode(message.code) && isOutputErrorOrigin(message.origin);
}
// src/session/queue/request-limit.ts
function queueRequestByteLimit(raw = process.env.ACPX_QUEUE_MAX_REQUEST_BYTES) {
	if (raw === void 0 || raw.trim() === "") return;
	const limit = Number(raw);
	if (!Number.isSafeInteger(limit) || limit < 0 || !/^\d+$/.test(raw.trim())) throw new Error("ACPX_QUEUE_MAX_REQUEST_BYTES must be a non-negative safe integer; zero is unlimited");
	return limit || void 0;
}
function queueRequestExceedsLimit(line, limit) {
	return limit !== void 0 && Buffer.byteLength(line, "utf8") > limit;
}
function assertQueueRequestSize(line) {
	const limit = queueRequestByteLimit();
	if (queueRequestExceedsLimit(line, limit)) throw new QueueProtocolError(`Queue request exceeded ACPX_QUEUE_MAX_REQUEST_BYTES (${limit} bytes); raise or unset the limit`, {
		detailCode: "QUEUE_REQUEST_TOO_LARGE",
		origin: "queue",
		retryable: false
	});
}
// src/session/queue/socket-output.ts
const OUTPUT_CHUNK_BYTES = 65536;
const DRAIN_TIMEOUT_MS = 1e3;
const DEFAULT_LIMITS = Object.freeze({
	observerBytes: 67108864,
	totalBytes: 268435456,
	observers: 64
});
var QueueOutputBudget = class {
	limits;
	bytes = 0;
	files = 0;
	observers = 0;
	constructor(limits = DEFAULT_LIMITS) {
		this.limits = limits;
	}
	acquire() {
		if (this.files >= this.limits.observers) throw new Error("Queue output spool descriptor limit reached");
		this.files += 1;
	}
	grow(bytes) {
		if (bytes > this.limits.totalBytes - this.bytes) throw new Error("Queue output spool storage limit reached");
		this.bytes += bytes;
	}
	release(bytes) {
		this.bytes -= bytes;
		this.files -= 1;
	}
	acquireObserver() {
		if (this.observers >= this.limits.observers) throw new Error("Queue blocked observer limit reached");
		this.observers += 1;
	}
	releaseObserver() {
		this.observers -= 1;
	}
};
var OutputRing = class {
	budget;
	fd;
	physicalBytes = 0;
	readOffset = 0;
	length = 0;
	constructor(budget) {
		this.budget = budget;
		budget.acquire();
		try {
			const root = resolveSecureTempRoot({ fallbackPrefix: "acpx-output" });
			const file = path.join(root, `${randomUUID()}.tmp`);
			this.fd = fs.openSync(file, "wx+", 384);
			fs.unlinkSync(file);
		} catch (error) {
			if (this.fd === void 0) budget.release(0);
			else this.close();
			throw error;
		}
	}
	append(bytes, offset) {
		const capacity = this.budget.limits.observerBytes;
		if (bytes.length - offset > capacity - this.length) throw new Error("Queue observer output backlog limit reached");
		while (offset < bytes.length) {
			const position = (this.readOffset + this.length) % capacity;
			const count = Math.min(OUTPUT_CHUNK_BYTES, bytes.length - offset, capacity - position);
			const growth = Math.max(0, position + count - this.physicalBytes);
			this.budget.grow(growth);
			this.physicalBytes += growth;
			const written = fs.writeSync(this.fd, bytes, offset, count, position);
			if (written <= 0) throw new Error("Queue output spool write made no progress");
			offset += written;
			this.length += written;
		}
	}
	read() {
		const capacity = this.budget.limits.observerBytes;
		const bytes = Buffer.allocUnsafeSlow(Math.min(OUTPUT_CHUNK_BYTES, this.length, capacity - this.readOffset));
		let offset = 0;
		while (offset < bytes.length) {
			const read = fs.readSync(this.fd, bytes, offset, bytes.length - offset, this.readOffset + offset);
			if (read <= 0) throw new Error("Queue output spool ended before its committed bytes");
			offset += read;
		}
		this.readOffset = (this.readOffset + bytes.length) % capacity;
		this.length -= bytes.length;
		return bytes;
	}
	close() {
		const fd = this.fd;
		this.fd = void 0;
		if (fd !== void 0) {
			fs.closeSync(fd);
			this.budget.release(this.physicalBytes);
		}
	}
};
var QueueSocketOutput = class {
	socket;
	budget;
	ring;
	blocked = false;
	ending = false;
	disposed = false;
	reserved = false;
	pendingWrites = 0;
	constructor(socket, budget) {
		this.socket = socket;
		this.budget = budget;
		socket.on("drain", this.onDrain);
		socket.once("close", () => {
			this.disposed = true;
			socket.off("drain", this.onDrain);
			this.closeSpool();
			this.releaseObserver();
		});
	}
	send(message) {
		if (this.ending || this.socket.destroyed || !this.socket.writable) return;
		try {
			this.writeFrame(Buffer.from(`${JSON.stringify(message)}\n`));
		} catch (error) {
			this.fail(error);
		}
	}
	writeFrame(bytes) {
		let offset = 0;
		while (!this.blocked && offset < bytes.length) {
			const end = Math.min(offset + OUTPUT_CHUNK_BYTES, bytes.length);
			const chunk = Buffer.allocUnsafeSlow(end - offset);
			bytes.copy(chunk, 0, offset, end);
			this.write(chunk);
			offset = end;
		}
		if (offset < bytes.length) {
			this.ring ??= new OutputRing(this.budget);
			this.ring.append(bytes, offset);
		}
	}
	end() {
		if (this.ending || this.socket.destroyed) return;
		this.ending = true;
		this.armTimeout();
		this.finishIfDrained();
	}
	write(bytes) {
		if (!this.reserved) {
			this.budget.acquireObserver();
			this.reserved = true;
		}
		this.pendingWrites += 1;
		try {
			this.blocked = !this.socket.write(bytes, this.onWrite);
		} catch (error) {
			this.pendingWrites -= 1;
			throw error;
		}
		if (this.blocked && !this.socket.timeout) this.armTimeout();
	}
	onWrite = (error) => {
		this.pendingWrites -= 1;
		if (this.disposed) return;
		if (error) {
			this.fail(error);
			return;
		}
		this.releaseIfIdle();
	};
	armTimeout() {
		if (process.platform !== "win32") this.socket.setTimeout(DRAIN_TIMEOUT_MS);
	}
	onDrain = () => {
		if (this.disposed) return;
		this.blocked = false;
		if (!this.ending) this.socket.setTimeout(0);
		try {
			this.pump();
			this.releaseIfIdle();
			this.finishIfDrained();
		} catch (error) {
			this.fail(error);
		}
	};
	pump() {
		while (!this.blocked && this.ring && this.ring.length > 0) this.write(this.ring.read());
		if (this.ring?.length === 0) this.closeSpool();
	}
	finishIfDrained() {
		if (this.ending && !this.ring?.length && !this.socket.writableEnded) this.socket.end(() => this.socket.destroy());
	}
	releaseObserver() {
		if (this.reserved) {
			this.reserved = false;
			this.budget.releaseObserver();
		}
	}
	releaseIfIdle() {
		if (this.pendingWrites === 0 && !this.blocked && !this.ring?.length) this.releaseObserver();
	}
	closeSpool() {
		const ring = this.ring;
		this.ring = void 0;
		try {
			ring?.close();
		} catch (error) {
			this.socket.destroy(error instanceof Error ? error : new Error(String(error)));
		}
	}
	fail(error) {
		this.disposed = true;
		this.socket.destroy(error instanceof Error ? error : new Error(String(error)));
		this.closeSpool();
	}
};
// src/session/queue/ipc-server.ts
const QUEUE_SOCKET_DRAIN_TIMEOUT_MS = 1e3;
function makeQueueOwnerError(requestId, message, detailCode, options = {}) {
	return {
		type: "error",
		requestId,
		ownerGeneration: void 0,
		code: "RUNTIME",
		detailCode,
		origin: "queue",
		retryable: options.retryable,
		message
	};
}
function makeQueueOwnerErrorFromUnknown(requestId, error, detailCode, options = {}) {
	const normalized = normalizeOutputError(error, {
		defaultCode: "RUNTIME",
		origin: "queue",
		detailCode,
		retryable: options.retryable
	});
	return {
		type: "error",
		requestId,
		code: normalized.code,
		detailCode: normalized.detailCode,
		origin: normalized.origin,
		message: normalized.message,
		retryable: normalized.retryable,
		acp: normalized.acp
	};
}
var SessionQueueOwner = class SessionQueueOwner {
	server;
	controlHandlers;
	ownerGeneration;
	maxQueueDepth;
	maxRequestBytes;
	onQueueDepthChanged;
	pending = [];
	activeTask;
	waiters = [];
	sockets = /* @__PURE__ */ new Set();
	taskSockets = /* @__PURE__ */ new Set();
	drainingSockets = /* @__PURE__ */ new Set();
	outputBudget = new QueueOutputBudget();
	outputs = /* @__PURE__ */ new Map();
	closed = false;
	constructor(server, controlHandlers, lease, options) {
		this.server = server;
		this.controlHandlers = controlHandlers;
		this.ownerGeneration = lease.ownerGeneration;
		this.maxQueueDepth = Math.max(1, Math.round(options.maxQueueDepth));
		this.maxRequestBytes = queueRequestByteLimit(options.maxRequestBytes?.toString());
		this.onQueueDepthChanged = options.onQueueDepthChanged;
	}
	static async start(lease, controlHandlers, options = { maxQueueDepth: 16 }) {
		const ownerRef = { current: void 0 };
		const server = net.createServer((socket) => {
			ownerRef.current?.handleConnection(socket);
		});
		ownerRef.current = new SessionQueueOwner(server, controlHandlers, lease, options);
		await new Promise((resolve, reject) => {
			const onListening = () => {
				server.off("error", onError);
				resolve();
			};
			const onError = (error) => {
				server.off("listening", onListening);
				reject(error);
			};
			server.once("listening", onListening);
			server.once("error", onError);
			server.listen(lease.socketPath);
		});
		return ownerRef.current;
	}
	beginShutdown() {
		if (this.closed) return;
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter(void 0);
		for (const task of this.pending.splice(0)) {
			if (task.waitForCompletion) task.send(makeQueueOwnerError(task.requestId, "Queue owner shutting down before prompt execution", "QUEUE_OWNER_SHUTTING_DOWN", { retryable: true }));
			task.close();
		}
		for (const socket of this.sockets) if (!this.taskSockets.has(socket) && !this.drainingSockets.has(socket)) socket.destroy();
		this.emitQueueDepth();
	}
	async close() {
		this.beginShutdown();
		await new Promise((resolve) => {
			const forceCloseTimer = setTimeout(() => {
				for (const socket of this.sockets) socket.destroy();
			}, QUEUE_SOCKET_DRAIN_TIMEOUT_MS);
			forceCloseTimer.unref();
			this.server.close(() => {
				clearTimeout(forceCloseTimer);
				resolve();
			});
		});
	}
	async nextTask(timeoutMs) {
		if (this.pending.length > 0) {
			const task = this.pending.shift();
			this.emitQueueDepth();
			if (task) {
				this.activeTask = task;
				recordPerfDuration("queue.owner.wait_ms", Date.now() - task.enqueuedAt);
			}
			return task;
		}
		if (this.closed) return;
		return await new Promise((resolve) => {
			const timer = timeoutMs != null && setTimeout(() => {
				const index = this.waiters.indexOf(waiter);
				if (index >= 0) this.waiters.splice(index, 1);
				resolve(void 0);
			}, Math.max(0, timeoutMs));
			const waiter = (task) => {
				if (timer) clearTimeout(timer);
				resolve(task);
			};
			this.waiters.push(waiter);
		});
	}
	queueDepth() {
		return this.pending.length;
	}
	completeTask(task) {
		if (this.activeTask === task) this.activeTask = void 0;
	}
	async cancelPrompt(targetRequestId) {
		if (targetRequestId === void 0) return await this.controlHandlers.cancelPrompt();
		const index = this.pending.findIndex((task) => task.requestId === targetRequestId);
		if (index >= 0) {
			const [task] = this.pending.splice(index, 1);
			task.send(makeQueueOwnerError(task.requestId, "Prompt cancelled before execution", "QUEUE_REQUEST_CANCELLED", { retryable: false }));
			task.close();
			this.emitQueueDepth();
			return true;
		}
		return this.activeTask?.requestId === targetRequestId ? await this.controlHandlers.cancelPrompt() : false;
	}
	emitQueueDepth() {
		this.onQueueDepthChanged?.(this.pending.length);
	}
	enqueue(task) {
		if (this.closed) {
			task.send(makeQueueOwnerError(task.requestId, "Queue owner is shutting down", "QUEUE_OWNER_SHUTTING_DOWN", { retryable: true }));
			task.close();
			return false;
		}
		if (this.activeTask?.requestId === task.requestId || this.pending.some((queued) => queued.requestId === task.requestId)) {
			task.send(makeQueueOwnerError(task.requestId, "Request is already queued or active", "QUEUE_REQUEST_DUPLICATE", { retryable: false }));
			task.close();
			return false;
		}
		const waiter = this.waiters.shift();
		if (waiter) {
			this.activeTask = task;
			waiter(task);
			return true;
		}
		if (this.pending.length >= this.maxQueueDepth) {
			task.send({
				...makeQueueOwnerError(task.requestId, `Queue owner is overloaded (${this.pending.length}/${this.maxQueueDepth} queued)`, "QUEUE_OWNER_OVERLOADED", { retryable: true }),
				ownerGeneration: this.ownerGeneration
			});
			task.close();
			return false;
		}
		this.pending.push(task);
		this.emitQueueDepth();
		return true;
	}
	handleControlRequest(options) {
		this.taskSockets.add(options.socket);
		this.writeQueueMessage(options.socket, {
			type: "accepted",
			requestId: options.requestId,
			ownerGeneration: this.ownerGeneration
		});
		options.run().then((message) => {
			this.writeQueueMessage(options.socket, {
				...message,
				ownerGeneration: this.ownerGeneration
			});
		}).catch((error) => {
			this.writeQueueMessage(options.socket, {
				...makeQueueOwnerErrorFromUnknown(options.requestId, error, "QUEUE_CONTROL_REQUEST_FAILED"),
				ownerGeneration: this.ownerGeneration
			});
		}).finally(() => {
			this.endSocket(options.socket);
		});
	}
	writeQueueMessage(socket, message) {
		this.outputs.get(socket)?.send(message);
	}
	endSocket(socket) {
		if (socket.destroyed || this.drainingSockets.has(socket)) return;
		this.taskSockets.delete(socket);
		this.drainingSockets.add(socket);
		this.outputs.get(socket)?.end();
	}
	failRequest(socket, requestId, message, detailCode) {
		this.writeQueueMessage(socket, {
			...makeQueueOwnerError(requestId, message, detailCode, { retryable: false }),
			ownerGeneration: this.ownerGeneration
		});
		this.endSocket(socket);
	}
	parseRequestLine(socket, line) {
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.failRequest(socket, "unknown", "Invalid queue request payload", "QUEUE_REQUEST_PAYLOAD_INVALID_JSON");
			return;
		}
		const request = parseQueueRequest(parsed);
		if (!request) this.failRequest(socket, "unknown", "Invalid queue request", "QUEUE_REQUEST_INVALID");
		return request ?? void 0;
	}
	rejectStaleOwnerGeneration(socket, request) {
		if (request.ownerGeneration === void 0 || this.ownerGeneration === void 0 || request.ownerGeneration === this.ownerGeneration) return false;
		this.failRequest(socket, request.requestId, "Queue request targeted a stale queue owner generation", "QUEUE_OWNER_GENERATION_MISMATCH");
		return true;
	}
	rejectClosedOwner(socket, request) {
		if (!this.closed) return false;
		this.writeQueueMessage(socket, {
			...makeQueueOwnerError(request.requestId, "Queue owner is shutting down", "QUEUE_OWNER_CLOSED", { retryable: true }),
			ownerGeneration: this.ownerGeneration
		});
		this.endSocket(socket);
		return true;
	}
	handleControlQueueRequest(socket, request) {
		if (request.type === "cancel_prompt") {
			this.handleControlRequest({
				socket,
				requestId: request.requestId,
				run: async () => ({
					type: "cancel_result",
					requestId: request.requestId,
					cancelled: await this.cancelPrompt(request.targetRequestId)
				})
			});
			return true;
		}
		if (request.type === "close_session") {
			this.handleControlRequest({
				socket,
				requestId: request.requestId,
				run: async () => ({
					type: "close_session_result",
					requestId: request.requestId,
					closed: await this.controlHandlers.closeSession(request.timeoutMs)
				})
			});
			return true;
		}
		return this.handleSessionControlQueueRequest(socket, request);
	}
	handleSessionControlQueueRequest(socket, request) {
		if (request.type === "set_mode") {
			this.handleControlRequest({
				socket,
				requestId: request.requestId,
				run: async () => {
					await this.controlHandlers.setSessionMode(request.modeId, request.timeoutMs);
					return {
						type: "set_mode_result",
						requestId: request.requestId,
						modeId: request.modeId
					};
				}
			});
			return true;
		}
		if (request.type === "set_model") {
			this.handleControlRequest({
				socket,
				requestId: request.requestId,
				run: async () => {
					const response = await this.controlHandlers.setSessionModel(request.modelId, request.timeoutMs);
					return {
						type: "set_model_result",
						requestId: request.requestId,
						modelId: request.modelId,
						response
					};
				}
			});
			return true;
		}
		if (request.type === "set_config_option") {
			this.handleControlRequest({
				socket,
				requestId: request.requestId,
				run: async () => ({
					type: "set_config_option_result",
					requestId: request.requestId,
					response: await this.controlHandlers.setSessionConfigOption(request.configId, request.value, request.timeoutMs)
				})
			});
			return true;
		}
		return false;
	}
	enqueuePromptRequest(socket, request) {
		this.taskSockets.add(socket);
		const task = {
			requestId: request.requestId,
			message: request.message,
			prompt: request.prompt ?? textPrompt(request.message),
			permissionMode: request.permissionMode,
			resumePolicy: request.resumePolicy,
			nonInteractivePermissions: request.nonInteractivePermissions,
			permissionPolicy: request.permissionPolicy,
			timeoutMs: request.timeoutMs,
			suppressSdkConsoleErrors: request.suppressSdkConsoleErrors,
			promptRetries: request.promptRetries,
			sessionOptions: request.sessionOptions,
			waitForCompletion: request.waitForCompletion,
			reportPromptStarted: request.reportPromptStarted,
			enqueuedAt: Date.now(),
			send: (message) => {
				this.writeQueueMessage(socket, {
					...message,
					ownerGeneration: this.ownerGeneration
				});
			},
			close: () => {
				this.endSocket(socket);
			}
		};
		if (!this.enqueue(task)) return;
		this.writeQueueMessage(socket, {
			type: "accepted",
			requestId: request.requestId,
			ownerGeneration: this.ownerGeneration
		});
		if (!request.waitForCompletion) task.close();
	}
	handleConnection(socket) {
		this.sockets.add(socket);
		this.outputs.set(socket, new QueueSocketOutput(socket, this.outputBudget));
		socket.setEncoding("utf8");
		socket.on("timeout", () => socket.destroy());
		socket.once("close", () => {
			this.outputs.delete(socket);
			this.sockets.delete(socket);
			this.taskSockets.delete(socket);
			this.drainingSockets.delete(socket);
		});
		let buffer = "";
		let handled = false;
		const processLine = (line) => {
			if (handled) return;
			handled = true;
			const request = this.parseRequestLine(socket, line);
			if (!request || this.rejectClosedOwner(socket, request) || this.rejectStaleOwnerGeneration(socket, request)) return;
			if (this.handleControlQueueRequest(socket, request)) return;
			if (request.type !== "submit_prompt") {
				this.failRequest(socket, request.requestId, "Invalid queue request", "QUEUE_REQUEST_INVALID");
				return;
			}
			this.enqueuePromptRequest(socket, request);
		};
		socket.on("data", (chunk) => {
			buffer += chunk;
			let index = buffer.indexOf("\n");
			while (index >= 0) {
				const rawLine = buffer.slice(0, index);
				if (this.rejectOversizedRequest(socket, rawLine)) return;
				const line = rawLine.trim();
				buffer = buffer.slice(index + 1);
				if (line.length > 0) processLine(line);
				index = buffer.indexOf("\n");
			}
			this.rejectOversizedRequest(socket, buffer);
		});
		socket.on("error", () => {});
	}
	rejectOversizedRequest(socket, line) {
		if (!queueRequestExceedsLimit(line, this.maxRequestBytes)) return false;
		socket.destroy();
		return true;
	}
};
// src/session/queue/ipc.ts
function assertOwnerGeneration(owner, message) {
	if (owner.ownerGeneration !== void 0 && message.ownerGeneration !== void 0 && message.ownerGeneration !== owner.ownerGeneration) throw new QueueProtocolError("Queue owner returned mismatched generation", {
		detailCode: "QUEUE_OWNER_GENERATION_MISMATCH",
		origin: "queue",
		retryable: true
	});
	return message;
}
function queueConnectionErrorFromOwner(message, outputAlreadyEmitted) {
	return new QueueConnectionError(message.message, {
		outputCode: message.code,
		detailCode: message.detailCode,
		origin: message.origin ?? "queue",
		retryable: message.retryable,
		acp: message.acp,
		...outputAlreadyEmitted ? { outputAlreadyEmitted: true } : {}
	});
}
function makeMalformedQueueMessageError() {
	return new QueueProtocolError("Queue owner sent malformed message", {
		detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
		origin: "queue",
		retryable: true
	});
}
function notifyObserver(notify) {
	try {
		notify?.();
	} catch {}
}
function uncertainQueueOutcome(error) {
	const message = error instanceof Error ? error.message : "Queue request failed";
	const options = {
		detailCode: error instanceof QueueProtocolError ? error.detailCode : "QUEUE_SUBMISSION_OUTCOME_UNKNOWN",
		origin: "queue",
		retryable: false
	};
	return new (error instanceof QueueProtocolError ? QueueProtocolError : QueueConnectionError)(`${message}; request outcome is unknown. Do not automatically resubmit.`, options);
}
function emitQueueOwnerError(formatter, policy, sessionId, message) {
	notifyObserver(() => formatter.setContext({ sessionId }));
	const queueErrorAlreadyEmitted = policy?.queueErrorAlreadyEmitted ?? true;
	const shouldEmitInFormatter = message.outputAlreadyEmitted !== true || !queueErrorAlreadyEmitted;
	if (shouldEmitInFormatter) {
		notifyObserver(() => formatter.onError({
			code: message.code ?? "RUNTIME",
			detailCode: message.detailCode,
			origin: message.origin ?? "queue",
			message: message.message,
			retryable: message.retryable,
			acp: message.acp
		}));
		notifyObserver(() => formatter.flush());
	}
	return queueConnectionErrorFromOwner(message, queueErrorAlreadyEmitted || shouldEmitInFormatter);
}
function parseQueueOwnerResponseLine(owner, requestId, line) {
	let parsed;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new QueueProtocolError("Queue owner sent invalid JSON payload", {
			detailCode: "QUEUE_PROTOCOL_INVALID_JSON",
			origin: "queue",
			retryable: true
		});
	}
	const parsedMessage = parseQueueOwnerMessage(parsed);
	if (!parsedMessage) throw makeMalformedQueueMessageError();
	const message = assertOwnerGeneration(owner, parsedMessage);
	if (message.requestId !== requestId) throw makeMalformedQueueMessageError();
	return message;
}
async function runQueueOwnerRequest(options) {
	options.signal?.throwIfAborted();
	const requestLine = JSON.stringify(options.request);
	assertQueueRequestSize(requestLine);
	const socket = await connectToQueueOwner(options.owner);
	if (!socket) {
		options.signal?.throwIfAborted();
		return;
	}
	socket.setEncoding("utf8");
	return await new Promise((resolve, reject) => {
		let settled = false;
		const responseFragments = [];
		const state = { acknowledged: false };
		const finishResolve = (result) => {
			if (settled) return;
			settled = true;
			options.signal?.removeEventListener("abort", onAbort);
			socket.removeAllListeners();
			if (!socket.destroyed) socket.end();
			resolve(result);
		};
		const finishReject = (error) => {
			if (settled) return;
			settled = true;
			options.signal?.removeEventListener("abort", onAbort);
			socket.removeAllListeners();
			if (!socket.destroyed) socket.destroy();
			reject(error);
		};
		const onAbort = () => finishReject(options.signal?.reason);
		const controls = {
			state,
			resolve: finishResolve,
			reject: finishReject
		};
		const processLine = (line) => {
			let message;
			try {
				message = parseQueueOwnerResponseLine(options.owner, options.request.requestId, line);
			} catch (error) {
				finishReject(uncertainQueueOutcome(error));
				return;
			}
			if (message.type === "accepted") {
				state.acknowledged = true;
				notifyObserver(() => options.onAccepted?.(controls));
				return;
			}
			try {
				options.onMessage(message, controls);
			} catch (error) {
				finishReject(uncertainQueueOutcome(error));
			}
		};
		socket.on("data", (chunk) => {
			try {
				let offset = 0;
				let newline = chunk.indexOf("\n");
				while (newline >= 0) {
					if (settled) return;
					responseFragments.push(chunk.slice(offset, newline));
					const line = responseFragments.join("").trim();
					responseFragments.length = 0;
					if (line.length > 0) processLine(line);
					offset = newline + 1;
					newline = chunk.indexOf("\n", offset);
				}
				if (!settled && offset < chunk.length) responseFragments.push(chunk.slice(offset));
			} catch (error) {
				finishReject(uncertainQueueOutcome(error));
			}
		});
		socket.once("error", (error) => {
			finishReject(uncertainQueueOutcome(error));
		});
		socket.once("close", () => {
			if (settled) return;
			options.onClose(controls);
		});
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) {
			onAbort();
			return;
		}
		try {
			options.assertDispatch?.();
		} catch (error) {
			finishReject(error);
			return;
		}
		try {
			socket.write(`${requestLine}\n`);
		} catch (error) {
			finishReject(uncertainQueueOutcome(error));
		}
	});
}
function missingQueueAckError() {
	return new QueueConnectionError("Queue owner did not acknowledge request; outcome unknown", {
		detailCode: "QUEUE_ACK_MISSING",
		origin: "queue",
		retryable: false
	});
}
function unexpectedQueueResponseError() {
	return new QueueProtocolError("Queue owner returned unexpected response; outcome unknown", {
		detailCode: "QUEUE_PROTOCOL_UNEXPECTED_RESPONSE",
		origin: "queue",
		retryable: false
	});
}
function handleAcknowledgedSubmitMessage(message, controls, formatter) {
	if (message.type === "event") {
		notifyObserver(() => formatter.onAcpMessage(message.message, message.direction));
		return;
	}
	if (message.type === "permission_escalation") {
		notifyObserver(() => formatter.onPermissionEscalation(message.event));
		return;
	}
	if (message.type === "result") {
		notifyObserver(() => formatter.flush());
		controls.resolve(message.result);
		return;
	}
	controls.reject(unexpectedQueueResponseError());
}
function handleSubmitQueueOwnerMessage(message, controls, options) {
	if (message.type === "error") {
		controls.reject(emitQueueOwnerError(options.outputFormatter, options.errorEmissionPolicy, options.sessionId, message));
		return;
	}
	if (!controls.state.acknowledged) {
		controls.reject(missingQueueAckError());
		return;
	}
	if (message.type === "prompt_started") {
		notifyObserver(options.onPromptStarted);
		return;
	}
	handleAcknowledgedSubmitMessage(message, controls, options.outputFormatter);
}
async function submitToQueueOwner(owner, options) {
	const requestId = options.requestId ?? randomUUID();
	const request = {
		type: "submit_prompt",
		requestId,
		ownerGeneration: owner.ownerGeneration,
		message: options.message,
		prompt: options.prompt,
		permissionMode: options.permissionMode,
		resumePolicy: options.resumePolicy,
		nonInteractivePermissions: options.nonInteractivePermissions,
		permissionPolicy: options.permissionPolicy,
		timeoutMs: options.timeoutMs,
		suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
		promptRetries: options.promptRetries ?? 0,
		waitForCompletion: options.waitForCompletion,
		...options.onPromptStarted ? { reportPromptStarted: true } : {},
		sessionOptions: options.sessionOptions
	};
	notifyObserver(() => options.outputFormatter.setContext({ sessionId: options.sessionId }));
	return await runQueueOwnerRequest({
		owner,
		request,
		signal: options.signal,
		onAccepted: ({ resolve }) => {
			notifyObserver(options.onQueueAccepted);
			notifyObserver(() => options.outputFormatter.setContext({ sessionId: options.sessionId }));
			if (!options.waitForCompletion) resolve({
				queued: true,
				sessionId: options.sessionId,
				requestId
			});
		},
		onMessage: (message, controls) => {
			handleSubmitQueueOwnerMessage(message, controls, options);
		},
		onClose: ({ state, resolve, reject }) => {
			if (!state.acknowledged) {
				reject(new QueueConnectionError("Queue owner disconnected before acknowledging request; outcome unknown", {
					detailCode: "QUEUE_DISCONNECTED_BEFORE_ACK",
					origin: "queue",
					retryable: false
				}));
				return;
			}
			if (!options.waitForCompletion) {
				resolve({
					queued: true,
					sessionId: options.sessionId,
					requestId
				});
				return;
			}
			reject(new QueueConnectionError("Queue owner disconnected before prompt completion; outcome unknown", {
				detailCode: "QUEUE_DISCONNECTED_BEFORE_COMPLETION",
				origin: "queue",
				retryable: false
			}));
		}
	});
}
async function submitControlToQueueOwner(owner, request, isExpectedResponse, assertDispatch) {
	return await runQueueOwnerRequest({
		owner,
		request,
		assertDispatch,
		onMessage: (message, { state, resolve, reject }) => {
			if (message.type === "error") {
				reject(queueConnectionErrorFromOwner(message, false));
				return;
			}
			if (!state.acknowledged) {
				reject(missingQueueAckError());
				return;
			}
			if (!isExpectedResponse(message)) {
				reject(unexpectedQueueResponseError());
				return;
			}
			resolve(message);
		},
		onClose: ({ state, reject }) => {
			if (!state.acknowledged) {
				reject(new QueueConnectionError("Queue owner disconnected before acknowledging request; outcome unknown", {
					detailCode: "QUEUE_DISCONNECTED_BEFORE_ACK",
					origin: "queue",
					retryable: false
				}));
				return;
			}
			reject(new QueueConnectionError("Queue owner disconnected before responding; outcome unknown", {
				detailCode: "QUEUE_DISCONNECTED_BEFORE_COMPLETION",
				origin: "queue",
				retryable: false
			}));
		}
	});
}
async function submitCancelToQueueOwner(owner, targetRequestId) {
	if (targetRequestId !== void 0) assertSharedRuntimeOwner(owner);
	return (await submitControlToQueueOwner(owner, {
		type: "cancel_prompt",
		requestId: randomUUID(),
		ownerGeneration: owner.ownerGeneration,
		...targetRequestId !== void 0 ? { targetRequestId } : {}
	}, (message) => message.type === "cancel_result"))?.cancelled;
}
async function submitSetModeToQueueOwner(owner, modeId, timeoutMs, assertDispatch) {
	return await submitControlToQueueOwner(owner, {
		type: "set_mode",
		requestId: randomUUID(),
		ownerGeneration: owner.ownerGeneration,
		modeId,
		timeoutMs
	}, (message) => message.type === "set_mode_result", assertDispatch) ? true : void 0;
}
async function submitSetModelToQueueOwner(owner, modelId, timeoutMs, assertDispatch) {
	return await submitControlToQueueOwner(owner, {
		type: "set_model",
		requestId: randomUUID(),
		ownerGeneration: owner.ownerGeneration,
		modelId,
		timeoutMs
	}, (message) => message.type === "set_model_result", assertDispatch);
}
async function submitSetConfigOptionToQueueOwner(owner, configId, value, timeoutMs, assertDispatch) {
	return (await submitControlToQueueOwner(owner, {
		type: "set_config_option",
		requestId: randomUUID(),
		ownerGeneration: owner.ownerGeneration,
		configId,
		value,
		timeoutMs
	}, (message) => message.type === "set_config_option_result", assertDispatch))?.response;
}
async function submitCloseSessionToQueueOwner(owner, timeoutMs) {
	return (await submitControlToQueueOwner(owner, {
		type: "close_session",
		requestId: randomUUID(),
		ownerGeneration: owner.ownerGeneration,
		timeoutMs
	}, (message) => message.type === "close_session_result"))?.closed;
}
function queueOwnerMcpConfigMatches(owner, options) {
	return owner.mcpConfigPath === options.mcpConfigPath && owner.mcpConfigFingerprint === options.mcpConfigFingerprint;
}
function assertQueueOwnerMcpConfigMatches(owner, options) {
	if (queueOwnerMcpConfigMatches(owner, options)) return;
	throw new QueueConnectionError("Session queue owner uses a different MCP config; close the session before retrying", {
		detailCode: "QUEUE_MCP_CONFIG_CONFLICT",
		origin: "queue",
		retryable: false
	});
}
function assertSharedRuntimeOwner(owner) {
	if (owner.sharedRuntime === true) return;
	throw new QueueConnectionError("The running queue owner predates shared runtime support. Wait for its idle expiry or close the session before retrying.", {
		detailCode: "QUEUE_SHARED_RUNTIME_UNSUPPORTED",
		origin: "queue",
		retryable: false
	});
}
async function trySubmitToRunningOwner(options) {
	options.signal?.throwIfAborted();
	const observed = await readQueueOwnerRecord(options.sessionId);
	if (!observed) return;
	const owner = await resolveUsableQueueOwner(options.sessionId, observed);
	if (!owner) return;
	if (options.requireSharedRuntime) assertSharedRuntimeOwner(owner);
	assertQueueOwnerMcpConfigMatches(owner, options);
	const submitted = await submitToQueueOwner(owner, options);
	if (submitted) {
		if (options.verbose) process.stderr.write(`[acpx] queued prompt on active owner pid ${owner.pid} for session ${options.sessionId}\n`);
		return submitted;
	}
	if (!(await probeQueueOwnerHealth(options.sessionId)).hasLease) return;
	throw new QueueConnectionError("Session queue owner is running but not accepting queue requests", {
		detailCode: "QUEUE_NOT_ACCEPTING_REQUESTS",
		origin: "queue",
		retryable: true
	});
}
async function tryControlOnRunningOwner(options) {
	const owner = await readQueueOwnerRecord(options.sessionId);
	if (!owner) return;
	const response = await options.submit(owner);
	if (response !== void 0) {
		if (options.verbose) process.stderr.write(`${options.logPrefix} ${owner.pid} for session ${options.sessionId}\n`);
		return response;
	}
	if (!(await probeQueueOwnerHealth(options.sessionId)).hasLease) return;
	throw new QueueConnectionError(`Session queue owner is running but not accepting ${options.requestName} requests`, {
		detailCode: "QUEUE_NOT_ACCEPTING_REQUESTS",
		origin: "queue",
		retryable: true
	});
}
async function tryCloseSessionOnRunningOwner(options) {
	return await tryControlOnRunningOwner({
		sessionId: options.sessionId,
		verbose: options.verbose,
		requestName: "close_session",
		logPrefix: "[acpx] requested session/close on active owner pid",
		submit: (owner) => {
			options.onOwnerSelected?.(owner);
			return submitCloseSessionToQueueOwner(owner, options.timeoutMs);
		}
	});
}
async function tryCancelOnRunningOwner(options) {
	return await tryControlOnRunningOwner({
		sessionId: options.sessionId,
		verbose: options.verbose,
		requestName: "cancel",
		logPrefix: "[acpx] requested cancel on active owner pid",
		submit: (owner) => submitCancelToQueueOwner(owner, options.targetRequestId)
	});
}
async function withOwnerControlPersistence(owner, operation) {
	const persistsControlState = owner.persistsControlState === true;
	const value = await operation;
	return value === void 0 ? void 0 : {
		value,
		persistsControlState
	};
}
async function trySetModeOnRunningOwner(sessionId, modeId, timeoutMs, verbose, assertDispatch) {
	return await tryControlOnRunningOwner({
		sessionId,
		verbose,
		requestName: "set_mode",
		logPrefix: "[acpx] requested session/set_mode on owner pid",
		submit: (owner) => withOwnerControlPersistence(owner, submitSetModeToQueueOwner(owner, modeId, timeoutMs, assertDispatch))
	});
}
async function trySetModelOnRunningOwner(sessionId, modelId, timeoutMs, verbose, assertDispatch) {
	return await tryControlOnRunningOwner({
		sessionId,
		verbose,
		requestName: "set_model",
		logPrefix: "[acpx] requested a model config update on owner pid",
		submit: (owner) => withOwnerControlPersistence(owner, submitSetModelToQueueOwner(owner, modelId, timeoutMs, assertDispatch))
	});
}
async function trySetConfigOptionOnRunningOwner(sessionId, configId, value, timeoutMs, verbose, assertDispatch) {
	return await tryControlOnRunningOwner({
		sessionId,
		verbose,
		requestName: "set_config_option",
		logPrefix: "[acpx] requested session/set_config_option on owner pid",
		submit: (owner) => withOwnerControlPersistence(owner, submitSetConfigOptionToQueueOwner(owner, configId, value, timeoutMs, assertDispatch))
	});
}
export { measurePerf as $, UnsupportedPromptContentError as $t, findSession as A, AUTH_POLICIES as At, assertPersistedKeyPolicy as B, AgentStartupError as Bt, textPrompt as C, exitCodeForOutputErrorCode as Ct, DEFAULT_HISTORY_LIMIT as D, normalizeOutputError as Dt, observeProcessIncarnation as E, isRetryablePromptError as Et, normalizeName as F, PERMISSION_POLICY_ACTIONS as Ft, normalizeAgentSessionId as G, PermissionDeniedError as Gt, canonicalAgentCommand as H, ClaudeAcpSessionCreateTimeoutError as Ht, pruneSessions as I, SESSION_RECORD_SCHEMA as It, SessionWatchError as J, SessionConfigOptionReplayError as Jt, SESSION_JOURNAL_SCHEMA as K, PermissionPromptUnavailableError as Kt, readSessionRecord as L, AcpxOperationalError as Lt, isoNow as M, NON_INTERACTIVE_PERMISSION_POLICIES as Mt, listSessions as N, OUTPUT_FORMATS as Nt, absolutePath as O, extractAcpError as Ot, listSessionsForAgent as P, PERMISSION_MODES as Pt, incrementPerfCounter as Q, SessionResumeRequiredError as Qt, resolveSessionRecord as R, AgentDisconnectedError as Rt, promptToDisplayText as S, isProcessAlive as St, lockOwnerPid as T, isAcpQueryClosedBeforeResponseError as Tt, serializeSessionRecordForDisk as U, CopilotAcpUnsupportedError as Ut, parseSessionRecord as V, AuthPolicyError as Vt, extractAgentSessionId as W, GeminiAcpStartupTimeoutError as Wt, formatPerfMetric as X, SessionModelReplayError as Xt, watchSession as Y, SessionModeReplayError as Yt, getPerfMetricsSnapshot as Z, SessionNotFoundError as Zt, ProcessDescendants as _, sessionEventLockPath as _t, trySetModelOnRunningOwner as a, isAcpMessageObject as at, mergePromptSourceWithText as b, writePrivateJsonFile as bt, probeQueueOwnerHealth as c, parsePermissionNotice as ct, releaseQueueOwnerLease as d, boundedEventMaxSegments as dt, resetPerfMetrics as et, terminateProcess as f, defaultSessionEventLog as ft, QueueLeaseGuardSettlementError as g, sessionEventActivePath as gt, waitMs as h, sessionBaseDir as ht, trySetModeOnRunningOwner as i, isAcpJsonRpcMessage as it, findSessionByDirectoryWalk as j, EXIT_CODES as jt, findGitRepositoryRoot as k, isAcpResourceNotFoundError as kt, readQueueOwnerRecord as l, parsePromptStopReason as lt, tryAcquireQueueOwnerLease as m, retainedEventMaxSegments as mt, tryCloseSessionOnRunningOwner as n, startPerfTimer as nt, trySubmitToRunningOwner as o, isSessionUpdateNotification as ot, terminateQueueOwnerForSession as p, existingEventSegmentIndices as pt, SessionJournalReader as q, QueueConnectionError as qt, trySetConfigOptionOnRunningOwner as r, extractSessionUpdateNotification as rt, SessionQueueOwner as s, parseJsonRpcErrorMessage as st, tryCancelOnRunningOwner as t, setPerfGauge as tt, refreshQueueOwnerLease as u, DEFAULT_EVENT_SEGMENT_MAX_BYTES as ut, PromptInputValidationError as v, sessionEventSegmentPath as vt, createLockOwner as w, formatErrorMessage as wt, parsePromptSource as x, _usingCtx as xt, getUnsupportedPromptContentMessage as y, writePrivateFile as yt, writeSessionRecord as z, AgentSpawnError as zt };
