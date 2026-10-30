import { A as findSession, B as assertPersistedKeyPolicy, C as textPrompt, Dt as normalizeOutputError, L as readSessionRecord, Ot as extractAcpError, R as resolveSessionRecord, U as serializeSessionRecordForDisk, V as parseSessionRecord, bt as writePrivateJsonFile, kt as isAcpResourceNotFoundError, t as tryCancelOnRunningOwner } from "./ipc-BbYFsKOj.js";
import { O as normalizeAgentCommandInput, a as createAgentRegistry, i as DEFAULT_AGENT_NAME } from "./agent-registry-Cz9fD9H1.js";
import { $ as isRequestedModelUnsupportedError, A as applyInitialModelSelection, B as reconcileAgentSessionId, C as setSessionModeOnOwner, D as connectAndLoadSession, E as withConnectedSession, F as persistSessionOptions, G as recordSessionUpdate, I as sessionOptionsFromRecord, J as advertisedModelState, K as trimConversationForRuntime, L as applyConversation, M as applyRequestedModelIfAdvertised, N as setDesiredModeId, O as applyConfigOptionSelection, P as normalizeSessionOptionShape, Q as RequestedModelUnsupportedError, R as applyLifecycleSnapshotToRecord, T as setSessionModelOnOwner, U as recordClientOperation, V as cloneSessionConversation, W as recordPromptSubmission, X as REQUESTED_MODEL_UNSUPPORTED_ERROR_CODE, Y as AcpClient, Z as REQUESTED_MODEL_UNSUPPORTED_REASONS, _ as cancelSessionPrompt, c as LiveSessionCheckpoint, et as resolveRequestedConfigOption, ft as TimeoutError, h as ensureSession, ht as withTimeout, j as applyModelSelection, k as applyConfigOptionsToRecord, l as runPromptTurn, pt as assertControlAuthority, q as cloneSessionAcpxState, r as sendSession, rt as snapshotEnvNames, s as DISCARD_OUTPUT_FORMATTER, tt as resolveRequestedModelId, v as closeSession, x as setSessionConfigOptionOnOwner, z as createInitialSessionRecord } from "./queue-owner-runtime-B0mPqOu4.js";
import { t as watchSession } from "./watch-bQXyUy3z.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
// src/runtime/public/errors.ts
var AcpRuntimeError = class extends Error {
	code;
	cause;
	constructor(code, message, options) {
		super(message);
		this.name = "AcpRuntimeError";
		this.code = code;
		this.cause = options?.cause;
	}
};
function isAcpRuntimeError(value) {
	return value instanceof AcpRuntimeError;
}
// src/runtime/engine/controls.ts
function advertisedConfigOptionIds(record) {
	const configOptions = record?.acpx?.config_options;
	if (!configOptions) return;
	return new Set(configOptions.map((option) => option.id).filter((id) => typeof id === "string" && id.trim().length > 0));
}
/** Caller-owned controls and the config option keys the session last advertised. */
function capabilitiesFromRecord(record) {
	const advertisedIds = advertisedConfigOptionIds(record);
	return {
		controls: [
			"session/set_mode",
			"session/set_model",
			"session/set_config_option",
			"session/status"
		],
		...advertisedIds?.size ? { configOptionKeys: [...advertisedIds] } : {}
	};
}
function resolveSupportedConfigOptionId(record, configId) {
	const advertisedIds = advertisedConfigOptionIds(record);
	if (!advertisedIds) return configId;
	if (advertisedIds.has(configId)) return configId;
	if (configId === "thinking" && advertisedIds.has("effort")) return "effort";
	const supported = [...advertisedIds].toSorted();
	const supportedText = supported.length > 0 ? supported.join(", ") : "none";
	throw new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", `ACP session ${record.acpxRecordId} does not advertise config option '${configId}'. Supported config options: ${supportedText}.`);
}
// src/runtime/public/shared.ts
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asTrimmedString(value) {
	return typeof value === "string" ? value.trim() : "";
}
function asString(value) {
	return typeof value === "string" ? value : void 0;
}
function asOptionalString(value) {
	return asTrimmedString(value) || void 0;
}
function deriveAgentFromSessionKey(sessionKey, fallbackAgent) {
	const match = sessionKey.match(/^agent:([^:]+):/i);
	return (match?.[1] ? asTrimmedString(match[1]) : "") || fallbackAgent;
}
// src/runtime/public/events.ts
const TOOL_OUTPUT_SUMMARY_MAX_CHARS = 500;
function safeParseJsonObject(line) {
	try {
		const parsed = JSON.parse(line);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
function asOptionalFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function resolveStructuredPromptPayload(parsed) {
	if (asTrimmedString(parsed.method) === "session/update") {
		const params = parsed.params;
		if (isRecord(params) && isRecord(params.update)) {
			const update = params.update;
			const tag = asOptionalString(update.sessionUpdate);
			return {
				type: tag ?? "",
				payload: update,
				...tag ? { tag } : {}
			};
		}
	}
	const sessionUpdate = asOptionalString(parsed.sessionUpdate);
	if (sessionUpdate) return {
		type: sessionUpdate,
		payload: parsed,
		tag: sessionUpdate
	};
	const type = asTrimmedString(parsed.type);
	const tag = asOptionalString(parsed.tag);
	return {
		type,
		payload: parsed,
		...tag ? { tag } : {}
	};
}
function resolveStatusTextForTag(params) {
	const resolver = STATUS_TEXT_RESOLVERS[params.tag];
	return resolver ? resolver(params.payload) : null;
}
const STATUS_TEXT_RESOLVERS = {
	available_commands_update: availableCommandsStatusText,
	current_mode_update: currentModeStatusText,
	config_option_update: configOptionStatusText,
	session_info_update: sessionInfoStatusText
};
function availableCommandsStatusText(payload) {
	const commands = Array.isArray(payload.availableCommands) ? payload.availableCommands : [];
	return commands.length > 0 ? `available commands updated (${commands.length})` : "available commands updated";
}
function currentModeStatusText(payload) {
	const mode = asTrimmedString(payload.currentModeId) || asTrimmedString(payload.modeId) || asTrimmedString(payload.mode);
	return mode ? `mode updated: ${mode}` : "mode updated";
}
function configOptionStatusText(payload) {
	const id = asTrimmedString(payload.id) || asTrimmedString(payload.configOptionId);
	const value = asTrimmedString(payload.currentValue) || asTrimmedString(payload.value) || asTrimmedString(payload.optionValue);
	if (id && value) return `config updated: ${id}=${value}`;
	return id ? `config updated: ${id}` : "config updated";
}
function sessionInfoStatusText(payload) {
	return asTrimmedString(payload.summary) || asTrimmedString(payload.message) || "session updated";
}
function planStatusText(payload) {
	const content = asTrimmedString((Array.isArray(payload.entries) ? payload.entries : []).find((entry) => isRecord(entry))?.content);
	return content ? `plan: ${content}` : null;
}
function isPlanEntryStatus(value) {
	return value === "pending" || value === "in_progress" || value === "completed";
}
function isPlanEntryPriority(value) {
	return value === "high" || value === "medium" || value === "low";
}
function planUpdateEvent(payload) {
	const raw = payload.entries;
	const entries = normalizePlanEntries(raw);
	if (Array.isArray(raw) && raw.length === 0) return {
		type: "status",
		text: "plan updated",
		tag: "plan",
		entries: []
	};
	const text = planStatusText(payload) ?? (entries.length > 0 ? `plan: ${entries[0]?.content}` : null);
	if (!text) return null;
	return {
		type: "status",
		text,
		tag: "plan",
		...entries.length > 0 ? { entries } : {}
	};
}
function normalizePlanEntries(value) {
	if (!Array.isArray(value)) return [];
	const entries = [];
	for (const entry of value) {
		const normalized = normalizePlanEntry(entry);
		if (normalized) entries.push(normalized);
	}
	return entries;
}
function normalizePlanEntry(value) {
	if (!isRecord(value)) return;
	const content = asTrimmedString(value.content);
	const status = asTrimmedString(value.status);
	if (!content || !isPlanEntryStatus(status)) return;
	const priority = asTrimmedString(value.priority);
	return {
		content,
		status,
		...isPlanEntryPriority(priority) ? { priority } : {}
	};
}
/**
* Documented allowlist for text_delta.meta origin fields.
* Only these keys may be copied from ACP update `_meta`.
* Unknown keys (including secret-like producer-controlled names) are dropped.
*/
const ORIGIN_META_KEYS = [
	"origin",
	"kind",
	"source"
];
/**
* Preserve a fail-closed subset of ACP update origin fields for text_delta
* consumers. Empty or unusable values are omitted rather than inferred.
*/
function extractTextDeltaOrigin(payload) {
	const messageId = asOptionalString(payload.messageId);
	const meta = sanitizeOriginMeta(payload._meta);
	return {
		...messageId ? { messageId } : {},
		...meta ? { meta } : {}
	};
}
/**
* Copy only allowlisted string origin keys from wire `_meta`.
* Nested objects, arrays, non-strings, and unknown keys are dropped.
*/
function sanitizeOriginMeta(value) {
	if (!isRecord(value)) return;
	const out = {};
	for (const key of ORIGIN_META_KEYS) {
		const entry = value[key];
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (!trimmed) continue;
		out[key] = trimmed;
	}
	return Object.keys(out).length > 0 ? out : void 0;
}
function resolveTextChunk(params) {
	const origin = extractTextDeltaOrigin(params.payload);
	const contentRaw = params.payload.content;
	if (isRecord(contentRaw)) {
		const contentType = asTrimmedString(contentRaw.type);
		if (contentType && contentType !== "text") return null;
		const text = asString(contentRaw.text);
		if (text && text.length > 0) return {
			type: "text_delta",
			text,
			stream: params.stream,
			tag: params.tag,
			...origin
		};
	}
	const text = asString(params.payload.text);
	if (!text || text.length === 0) return null;
	return {
		type: "text_delta",
		text,
		stream: params.stream,
		tag: params.tag,
		...origin
	};
}
function createTextDeltaEvent(params) {
	if (params.content == null || params.content.length === 0) return null;
	return {
		type: "text_delta",
		text: params.content,
		stream: params.stream,
		...params.tag ? { tag: params.tag } : {}
	};
}
function readFirstString(record, keys) {
	for (const key of keys) {
		const value = asOptionalString(record[key]);
		if (value) return value;
	}
}
function readFirstStringArray(record, keys) {
	for (const key of keys) {
		const value = record[key];
		if (!Array.isArray(value)) continue;
		const entries = value.map((entry) => asOptionalString(entry)).filter((entry) => entry !== void 0);
		if (entries.length > 0) return entries;
	}
}
function summarizeToolInput(rawInput) {
	if (rawInput == null) return;
	if (typeof rawInput === "string" || typeof rawInput === "number" || typeof rawInput === "boolean") return String(rawInput);
	if (!isRecord(rawInput)) return;
	const command = readFirstString(rawInput, [
		"command",
		"cmd",
		"program"
	]);
	const args = readFirstStringArray(rawInput, ["args", "arguments"]);
	if (command) return [command, ...args ?? []].join(" ");
	return readFirstString(rawInput, [
		"path",
		"file",
		"filePath",
		"filepath",
		"target",
		"uri",
		"url",
		"query",
		"pattern",
		"text",
		"search"
	]);
}
function truncateToolSummary(value) {
	if (value.length <= TOOL_OUTPUT_SUMMARY_MAX_CHARS) return value;
	return `${value.slice(0, 499)}…`;
}
function readToolContentText(value) {
	const record = isRecord(value) ? value : void 0;
	if (!record) return;
	if (record.type === "content") return readToolContentText(record.content);
	return toolContentTextReader(String(record.type))?.(record);
}
const TOOL_CONTENT_TEXT_READERS = {
	text: (record) => asString(record.text),
	audio: (record) => `[audio] ${asOptionalString(record.mimeType) || "audio"}`,
	resource_link: (record) => asOptionalString(record.title) || asOptionalString(record.name) || asOptionalString(record.uri),
	resource: (record) => {
		const resource = isRecord(record.resource) ? record.resource : void 0;
		return asString(resource?.text) || asOptionalString(resource?.uri);
	},
	diff: (record) => `diff ${asOptionalString(record.path) || "file"}`,
	terminal: (record) => {
		const terminalId = asOptionalString(record.terminalId) || asOptionalString(record.id);
		return terminalId ? `[terminal] ${terminalId}` : "[terminal]";
	}
};
function toolContentTextReader(type) {
	return Object.hasOwn(TOOL_CONTENT_TEXT_READERS, type) ? TOOL_CONTENT_TEXT_READERS[type] : void 0;
}
function summarizeToolContent(content) {
	if (!Array.isArray(content)) return;
	const fragments = content.map((entry) => readToolContentText(entry)?.trim()).filter((entry) => Boolean(entry));
	if (fragments.length === 0) return;
	return truncateToolSummary([...new Set(fragments)].join("\n"));
}
function summarizeToolOutput(rawOutput) {
	if (rawOutput == null) return;
	if (isScalarToolOutput(rawOutput)) return truncateToolSummary(String(rawOutput));
	const record = isRecord(rawOutput) ? rawOutput : void 0;
	if (!record) return;
	return truncateToolSummary(readFirstString(record, [
		"text",
		"message",
		"error",
		"stdout",
		"stderr",
		"content"
	]) ?? "") || void 0;
}
function isScalarToolOutput(value) {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
function shouldForwardArray(value) {
	return Array.isArray(value);
}
function readToolKind(value) {
	const kind = asOptionalString(value);
	return kind && TOOL_KINDS.has(kind) ? kind : void 0;
}
const TOOL_KINDS = /* @__PURE__ */ new Set([
	"read",
	"edit",
	"delete",
	"move",
	"search",
	"execute",
	"fetch",
	"think",
	"switch_mode",
	"other"
]);
function createToolCallEvent(params) {
	const title = asTrimmedString(params.payload.title) || "tool call";
	const status = asTrimmedString(params.payload.status);
	const inputSummary = summarizeToolInput(params.payload.rawInput);
	const outputSummary = summarizeToolContent(params.payload.content) ?? summarizeToolOutput(params.payload.rawOutput);
	const toolCallId = asOptionalString(params.payload.toolCallId);
	const kind = readToolKind(params.payload.kind);
	const summaryText = status ? `${title} (${status})` : title;
	const detailSummary = params.tag === "tool_call_update" ? outputSummary ?? inputSummary : inputSummary ?? outputSummary;
	const event = {
		type: "tool_call",
		text: detailSummary ? `${summaryText}: ${detailSummary}` : summaryText,
		tag: params.tag,
		title
	};
	assignToolCallEventMetadata(event, params.payload, {
		toolCallId,
		status,
		kind
	});
	return event;
}
function assignToolCallEventMetadata(event, payload, values) {
	if (event.type !== "tool_call") return;
	if (values.toolCallId) event.toolCallId = values.toolCallId;
	if (values.status) event.status = values.status;
	if (values.kind) event.kind = values.kind;
	assignForwardedToolPayload(event, payload);
}
function assignForwardedToolPayload(event, payload) {
	if (shouldForwardArray(payload.locations)) event.locations = payload.locations;
	if (Object.prototype.hasOwnProperty.call(payload, "rawInput")) event.rawInput = payload.rawInput;
	if (Object.prototype.hasOwnProperty.call(payload, "rawOutput")) event.rawOutput = payload.rawOutput;
	if (shouldForwardArray(payload.content)) event.content = payload.content;
}
function parsePromptEventLine(line) {
	const trimmed = line.trim();
	if (!trimmed) return null;
	const parsed = safeParseJsonObject(trimmed);
	if (!parsed) return {
		type: "status",
		text: trimmed
	};
	const structured = resolveStructuredPromptPayload(parsed);
	const type = structured.type;
	const payload = structured.payload;
	const tag = structured.tag;
	const parser = promptEventParser(type);
	return parser ? parser(payload, tag) : null;
}
const PROMPT_EVENT_PARSERS = {
	text: (payload, tag) => createTextDeltaEvent({
		content: asString(payload.content),
		stream: "output",
		tag
	}),
	thought: (payload, tag) => createTextDeltaEvent({
		content: asString(payload.content),
		stream: "thought",
		tag
	}),
	tool_call: (payload, tag) => createToolCallEvent({
		payload,
		tag: tag ?? "tool_call"
	}),
	tool_call_update: (payload, tag) => createToolCallEvent({
		payload,
		tag: tag ?? "tool_call_update"
	}),
	agent_message_chunk: (payload) => resolveTextChunk({
		payload,
		stream: "output",
		tag: "agent_message_chunk"
	}),
	agent_thought_chunk: (payload) => resolveTextChunk({
		payload,
		stream: "thought",
		tag: "agent_thought_chunk"
	}),
	usage_update: usageUpdateEvent,
	available_commands_update: availableCommandsUpdateEvent,
	current_mode_update: (payload) => statusUpdateEvent("current_mode_update", payload),
	config_option_update: (payload) => statusUpdateEvent("config_option_update", payload),
	session_info_update: (payload) => statusUpdateEvent("session_info_update", payload),
	plan: planUpdateEvent,
	client_operation: clientOperationEvent,
	update: updateStatusEvent,
	done: () => null,
	error: () => null
};
function promptEventParser(type) {
	return Object.hasOwn(PROMPT_EVENT_PARSERS, type) ? PROMPT_EVENT_PARSERS[type] : void 0;
}
function usageUpdateEvent(payload) {
	const used = asOptionalFiniteNumber(payload.used);
	const size = asOptionalFiniteNumber(payload.size);
	const meta = isRecord(payload._meta) ? payload._meta : void 0;
	return buildUsageUpdateEvent({
		used,
		size,
		cost: normalizeUsageCost(payload.cost),
		breakdown: normalizeUsageBreakdown(meta?.usage)
	});
}
function buildUsageUpdateEvent(parts) {
	const { used, size, cost, breakdown } = parts;
	return {
		type: "status",
		text: used != null && size != null ? `usage updated: ${used}/${size}` : "usage updated",
		tag: "usage_update",
		...used != null ? { used } : {},
		...size != null ? { size } : {},
		...cost ? { cost } : {},
		...breakdown ? { breakdown } : {}
	};
}
function availableCommandsUpdateEvent(payload) {
	const raw = Array.isArray(payload.availableCommands) ? payload.availableCommands : [];
	const availableCommands = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		const name = asTrimmedString(entry.name);
		if (!name) continue;
		const description = asTrimmedString(entry.description);
		availableCommands.push({
			name,
			...description ? { description } : {},
			hasInput: entry.input != null
		});
	}
	return {
		type: "status",
		text: availableCommands.length > 0 ? `available commands updated (${availableCommands.length})` : "available commands updated",
		tag: "available_commands_update",
		availableCommands
	};
}
function normalizeUsageCost(value) {
	if (!isRecord(value)) return;
	const amount = asOptionalFiniteNumber(value.amount);
	const currency = asTrimmedString(value.currency);
	if (amount == null && !currency) return;
	return {
		...amount != null ? { amount } : {},
		...currency ? { currency } : {}
	};
}
const USAGE_BREAKDOWN_FIELDS = [
	["inputTokens", ["inputTokens", "input_tokens"]],
	["outputTokens", ["outputTokens", "output_tokens"]],
	["cachedReadTokens", [
		"cachedReadTokens",
		"cacheReadInputTokens",
		"cache_read_input_tokens"
	]],
	["cachedWriteTokens", [
		"cachedWriteTokens",
		"cacheCreationInputTokens",
		"cache_creation_input_tokens"
	]],
	["thoughtTokens", ["thoughtTokens", "thought_tokens"]],
	["totalTokens", ["totalTokens", "total_tokens"]]
];
function normalizeUsageBreakdown(value) {
	if (!isRecord(value)) return;
	const breakdown = {};
	for (const [key, aliases] of USAGE_BREAKDOWN_FIELDS) {
		const v = firstFiniteNumber(value, aliases);
		if (v != null) breakdown[key] = v;
	}
	return Object.keys(breakdown).length > 0 ? breakdown : void 0;
}
function firstFiniteNumber(record, keys) {
	for (const key of keys) {
		const value = asOptionalFiniteNumber(record[key]);
		if (value != null) return value;
	}
}
function statusUpdateEvent(tag, payload) {
	const text = resolveStatusTextForTag({
		tag,
		payload
	});
	if (!text) return null;
	return {
		type: "status",
		text,
		tag
	};
}
function clientOperationEvent(payload, tag) {
	const text = [
		asTrimmedString(payload.method) || "operation",
		asTrimmedString(payload.status),
		asTrimmedString(payload.summary)
	].filter(Boolean).join(" ");
	return text ? {
		type: "status",
		text,
		...tag ? { tag } : {}
	} : null;
}
function updateStatusEvent(payload, tag) {
	const update = asTrimmedString(payload.update);
	return update ? {
		type: "status",
		text: update,
		...tag ? { tag } : {}
	} : null;
}
// src/runtime/public/probe.ts
/**
* Inspect session model metadata without a runtime store or prompt. The agent
* may create native session history; only its owned transport is closed.
*/
async function inspectAgentModels(options) {
	options.signal?.throwIfAborted();
	const timeoutMs = options.timeoutMs ?? 12e4;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new RangeError("Model inspection timeoutMs must be positive and at most 2147483647");
	const deadline = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
	const assertActive = () => signal.throwIfAborted();
	const client = new AcpClient({
		...normalizeAgentCommandInput(options.agentCommand),
		cwd: options.cwd,
		agentProcessEnv: options.agentProcessEnv,
		agentProcessEnvAllow: options.agentProcessEnvAllow,
		agentProcessEnvBlock: options.agentProcessEnvBlock,
		permissionMode: "deny-all",
		nonInteractivePermissions: "deny",
		fs: false,
		terminal: false,
		processLifecycle: {
			onBeforeSpawn: assertActive,
			onSpawned: assertActive
		}
	});
	const timer = setTimeout(() => deadline.abort(new TimeoutError(timeoutMs)), timeoutMs);
	let onAbort;
	const aborted = new Promise((_resolve, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	const inspection = (async () => {
		assertActive();
		await client.start();
		assertActive();
		const { models } = await client.createSession();
		assertActive();
		return models ? {
			currentModelId: models.currentModelId,
			availableModelIds: models.availableModels.map((model) => model.modelId),
			availableModels: models.availableModels
		} : void 0;
	})();
	try {
		return await Promise.race([inspection, aborted]);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
		try {
			if (signal.aborted) await client.close();
		} finally {
			await inspection.catch(() => {});
			await client.close();
		}
	}
}
function isPrimitiveDetail(value) {
	return value == null || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" || typeof value === "symbol";
}
function formatFunctionDetail(value) {
	return value.name ? `[Function ${value.name}]` : "[Function]";
}
function serializeRuntimeDetail(value) {
	const seen = /* @__PURE__ */ new WeakSet();
	return JSON.stringify(value, (_key, nested) => {
		if (nested instanceof Error) return nested.message || nested.name;
		if (nested && typeof nested === "object") {
			if (seen.has(nested)) return "[Circular]";
			seen.add(nested);
		}
		return nested;
	}) ?? "undefined";
}
function formatRuntimeDetail(value) {
	if (value instanceof Error) return value.message || value.name;
	if (typeof value === "string") return value;
	if (isPrimitiveDetail(value)) return String(value);
	if (typeof value === "function") return formatFunctionDetail(value);
	try {
		return serializeRuntimeDetail(value);
	} catch {
		return "unserializable object";
	}
}
function normalizeRuntimeDetails(details) {
	return details?.map((detail) => formatRuntimeDetail(detail));
}
async function probeRuntime(options, deps = {}) {
	const agentName = options.probeAgent?.trim() || "codex";
	const agentCommand = normalizeAgentCommandInput(options.agentRegistry.resolve(agentName));
	const client = createProbeClient(options, agentName, agentCommand, deps);
	try {
		await client.start();
		return {
			ok: true,
			message: "embedded ACP runtime ready",
			details: [
				`agent=${agentName}`,
				`command=${agentCommand.agentCommand}`,
				`cwd=${options.cwd}`,
				...client.initializeResult?.protocolVersion ? [`protocolVersion=${client.initializeResult.protocolVersion}`] : []
			]
		};
	} catch (error) {
		return {
			ok: false,
			message: "embedded ACP runtime probe failed",
			details: [
				`agent=${agentName}`,
				`command=${agentCommand.agentCommand}`,
				`cwd=${options.cwd}`,
				formatRuntimeDetail(error)
			]
		};
	} finally {
		await client.close().catch(() => {});
	}
}
function createProbeClient(options, agentName, agentCommand, deps) {
	const clientOptions = {
		...agentCommand,
		cwd: options.cwd,
		agentProcessEnv: options.agentProcessEnv,
		agentProcessEnvAllow: options.agentProcessEnvAllow,
		agentProcessEnvBlock: options.agentProcessEnvBlock,
		mcpServers: typeof options.mcpServers === "function" ? [] : [...options.mcpServers ?? []],
		permissionMode: options.permissionMode,
		nonInteractivePermissions: options.nonInteractivePermissions,
		permissionPolicy: options.permissionPolicy,
		fs: false,
		terminal: false,
		processLifecycle: options.processLifecycle,
		processLaunchScope: {
			kind: "runtime-probe",
			agent: agentName
		},
		verbose: options.verbose
	};
	return deps.clientFactory?.(clientOptions) ?? new AcpClient(clientOptions);
}
// src/runtime/engine/reuse-policy.ts
function shouldReuseExistingRecord(record, params) {
	if (record.acpx?.reset_on_next_ensure === true) return false;
	if (path.resolve(record.cwd) !== path.resolve(params.cwd)) return false;
	if (record.agentCommand !== params.agentCommand) return false;
	if (!sameArgv(record.agentArgv, params.agentArgv)) return false;
	if (params.resumeSessionId && record.acpSessionId !== params.resumeSessionId) return false;
	return true;
}
function sameArgv(left, right) {
	const leftValues = left ?? [];
	const rightValues = right ?? [];
	return leftValues.length === rightValues.length && leftValues.every((value, index) => value === rightValues[index]);
}
// src/runtime/engine/status.ts
function runtimeStatusFromRecord(record) {
	return {
		...record.lastRequestId ? { lastRequestId: record.lastRequestId } : {},
		summary: statusSummary(record),
		acpxRecordId: record.acpxRecordId,
		backendSessionId: record.acpSessionId,
		agentSessionId: record.agentSessionId,
		...buildModelsField(record),
		...buildUsageField(record),
		...buildAvailableCommandsField(record),
		details: {
			cwd: record.cwd,
			lastUsedAt: record.lastUsedAt,
			closed: record.closed === true,
			...record.acpx?.config_options !== void 0 ? { configOptions: structuredClone(record.acpx.config_options) } : {}
		}
	};
}
function statusSummary(record) {
	return [
		`session=${record.acpxRecordId}`,
		`backendSessionId=${record.acpSessionId}`,
		record.agentSessionId ? `agentSessionId=${record.agentSessionId}` : null,
		record.pid != null ? `pid=${record.pid}` : null,
		record.closed ? "closed" : "open"
	].filter(Boolean).join(" ");
}
function buildModelsField(record) {
	const { available_models: available = [], current_model_id: currentModelId } = record.acpx ?? {};
	if (available.length === 0 && currentModelId === void 0) return {};
	return { models: {
		...currentModelId !== void 0 ? { currentModelId } : {},
		availableModelIds: [...available],
		...buildModelNamesField(record.acpx)
	} };
}
function buildModelNamesField(state) {
	const models = advertisedModelState(state);
	return models && (models.configId || state?.available_model_names !== void 0) ? { availableModels: models.availableModels } : {};
}
function tokenUsageToBreakdown(usage) {
	if (!usage) return;
	const breakdown = {};
	assignUsageBreakdownField(breakdown, "inputTokens", usage.input_tokens);
	assignUsageBreakdownField(breakdown, "outputTokens", usage.output_tokens);
	assignUsageBreakdownField(breakdown, "cachedReadTokens", usage.cache_read_input_tokens);
	assignUsageBreakdownField(breakdown, "cachedWriteTokens", usage.cache_creation_input_tokens);
	assignUsageBreakdownField(breakdown, "thoughtTokens", usage.thought_tokens);
	assignUsageBreakdownField(breakdown, "totalTokens", usage.total_tokens);
	return Object.keys(breakdown).length > 0 ? breakdown : void 0;
}
function assignUsageBreakdownField(breakdown, key, value) {
	if (value !== void 0) breakdown[key] = value;
}
function buildUsageField(record) {
	const cumulative = tokenUsageToBreakdown(record.cumulative_token_usage);
	const perRequestEntries = Object.entries(record.request_token_usage ?? {}).map(([id, value]) => [id, tokenUsageToBreakdown(value)]).filter((entry) => entry[1] !== void 0);
	const perRequest = perRequestEntries.length > 0 ? Object.fromEntries(perRequestEntries) : void 0;
	const cost = record.cumulative_cost;
	const usage = {
		...cumulative ? { cumulative } : {},
		...cost ? { cost } : {},
		...perRequest ? { perRequest } : {}
	};
	return Object.keys(usage).length > 0 ? { usage } : {};
}
function buildAvailableCommandsField(record) {
	const commands = record.acpx?.available_commands;
	if (!commands || commands.length === 0) return {};
	const availableCommands = commands.map((command) => runtimeAvailableCommand(command)).filter((command) => command !== void 0);
	return availableCommands.length > 0 ? { availableCommands } : {};
}
function runtimeAvailableCommand(command) {
	if (typeof command === "string") {
		const name = command.trim();
		return name ? { name } : void 0;
	}
	const record = commandRecord(command);
	if (!record) return;
	const name = asOptionalString(record.name);
	if (!name) return;
	const runtimeCommand = { name };
	const description = asOptionalString(record.description);
	if (description) runtimeCommand.description = description;
	if (typeof record.has_input === "boolean") runtimeCommand.hasInput = record.has_input;
	return runtimeCommand;
}
function commandRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
// src/runtime/engine/turn.ts
function createDeferred() {
	let resolve;
	let reject;
	return {
		promise: new Promise((res, rej) => {
			resolve = res;
			reject = rej;
		}),
		resolve,
		reject
	};
}
var AsyncEventQueue = class {
	items = [];
	waits = [];
	closed = false;
	push(item) {
		if (this.closed) return;
		const waiter = this.waits.shift();
		if (waiter) {
			waiter.resolve(item);
			return;
		}
		this.items.push(item);
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		for (const waiter of this.waits.splice(0)) waiter.resolve(null);
	}
	clear() {
		this.items.length = 0;
	}
	async next() {
		if (this.items.length > 0) return this.items.shift() ?? null;
		if (this.closed) return null;
		const waiter = createDeferred();
		this.waits.push(waiter);
		return await waiter.promise;
	}
	async *iterate() {
		try {
			while (true) {
				const next = await this.next();
				if (!next) return;
				yield next;
			}
		} finally {
			this.close();
			this.clear();
		}
	}
};
function toPromptInput(text, attachments) {
	if (!attachments || attachments.length === 0) return text;
	const blocks = [];
	if (text) blocks.push({
		type: "text",
		text
	});
	for (const attachment of attachments) {
		if (attachment.mediaType.startsWith("image/")) {
			blocks.push({
				type: "image",
				mimeType: attachment.mediaType,
				data: attachment.data
			});
			continue;
		}
		if (attachment.mediaType.startsWith("audio/")) {
			blocks.push({
				type: "audio",
				mimeType: attachment.mediaType,
				data: attachment.data
			});
			continue;
		}
		throw new AcpRuntimeError("ACP_TURN_FAILED", `Unsupported ACP runtime attachment media type: ${attachment.mediaType}`);
	}
	return blocks.length > 0 ? blocks : textPrompt(text);
}
function legacyTerminalEventFromTurnResult(result) {
	if (result.status === "failed") return {
		type: "error",
		message: result.error.message,
		...result.error.code ? { code: result.error.code } : {},
		...result.error.detailCode ? { detailCode: result.error.detailCode } : {},
		...result.error.retryable === void 0 ? {} : { retryable: result.error.retryable }
	};
	return {
		type: "done",
		...result.stopReason ? { stopReason: result.stopReason } : {},
		...result._meta === void 0 ? {} : { _meta: result._meta }
	};
}
// src/runtime/engine/manager.ts
async function settleAttempt(run) {
	try {
		return {
			ok: true,
			value: await run()
		};
	} catch (error) {
		return {
			ok: false,
			error
		};
	}
}
function firstFailedAttempt(attempts) {
	return attempts.find((attempt) => !attempt.ok);
}
function isoNow() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function isUnsupportedSessionCloseError(error) {
	const acp = extractAcpError(error);
	if (!acp) return false;
	if (acp.code === -32601 || acp.code === -32602) return true;
	if (acp.code !== -32603 || !acp.data || typeof acp.data !== "object") return false;
	const details = acp.data.details;
	return typeof details === "string" && details.toLowerCase().includes("invalid params");
}
function createRecordId(sessionKey, mode) {
	if (mode === "persistent") return sessionKey;
	return `${sessionKey}:oneshot:${randomUUID()}`;
}
function resumePolicyForSessionMode(mode) {
	return mode === "persistent" ? "same-session-only" : "allow-new";
}
async function startRuntimeClient(client, agent, timeoutMs) {
	try {
		await withTimeout(client.start(), timeoutMs);
	} catch (error) {
		if (!(error instanceof TimeoutError)) throw error;
		throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", `ACP agent ${path.basename(agent.agentArgv?.[0] ?? agent.agentCommand.split(/\s+/)[0])} did not complete ACP initialization within ${timeoutMs}ms. Check that the configured command starts an ACP server.`, { cause: error });
	}
}
async function createOrLoadRuntimeSession(client, resumeSessionId, cwd) {
	if (resumeSessionId) {
		if (client.supportsResumeSession()) {
			const resumed = await client.resumeSession(resumeSessionId, cwd);
			return {
				sessionId: resumeSessionId,
				agentSessionId: resumed.agentSessionId,
				sessionResult: resumed
			};
		}
		if (!client.supportsLoadSession()) throw new Error(`Agent does not support session/resume or session/load; cannot resume session ${resumeSessionId}`);
		const loaded = await client.loadSession(resumeSessionId, cwd);
		return {
			sessionId: resumeSessionId,
			agentSessionId: loaded.agentSessionId,
			sessionResult: loaded
		};
	}
	const created = await client.createSession(cwd);
	return {
		sessionId: created.sessionId,
		agentSessionId: created.agentSessionId,
		sessionResult: created
	};
}
var AcpRuntimeManager = class {
	options;
	deps;
	activeControllers = /* @__PURE__ */ new Map();
	controlSessionRecords = /* @__PURE__ */ new Map();
	retainedSessionOwners = /* @__PURE__ */ new Map();
	retiringSessionOwners = /* @__PURE__ */ new Set();
	pendingOneShotRecordIds = /* @__PURE__ */ new Map();
	ensureSessionLocks = /* @__PURE__ */ new Map();
	runtimeOperationLocks = /* @__PURE__ */ new Map();
	sessionTasks = /* @__PURE__ */ new Map();
	closingActiveRecords = /* @__PURE__ */ new Set();
	liveClients = /* @__PURE__ */ new Set();
	pendingTasks = /* @__PURE__ */ new Set();
	shuttingDown = false;
	shutdownTask;
	constructor(options, deps = {}) {
		this.options = options;
		this.deps = deps;
	}
	createClient(options) {
		this.assertOpen();
		const clientOptions = {
			...options,
			agentProcessEnv: this.options.agentProcessEnv,
			agentProcessEnvAllow: this.options.agentProcessEnvAllow,
			agentProcessEnvBlock: this.options.agentProcessEnvBlock,
			processLifecycle: {
				...options.processLifecycle,
				onBeforeSpawn: async (launch) => {
					this.assertOpen();
					await options.processLifecycle?.onBeforeSpawn?.(launch);
					this.assertOpen();
				},
				onSpawned: async (process) => {
					this.assertOpen();
					await options.processLifecycle?.onSpawned?.(process);
					this.assertOpen();
				}
			}
		};
		const client = this.deps.clientFactory?.(clientOptions) ?? new AcpClient(clientOptions);
		this.liveClients.add(client);
		return client;
	}
	async probe() {
		let client;
		try {
			return await probeRuntime(this.options, { clientFactory: (options) => client = this.createClient(options) });
		} finally {
			if (client) this.liveClients.delete(client);
		}
	}
	assertOpen() {
		if (this.shuttingDown) throw new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "ACP runtime is shut down.");
	}
	shutdown() {
		if (!this.shutdownTask) {
			this.shuttingDown = true;
			this.shutdownTask = this.shutdownOwnedClients();
		}
		return this.shutdownTask;
	}
	async shutdownOwnedClients() {
		const closed = await Promise.allSettled([...this.liveClients].map(async (client) => {
			client.requestCancelActivePrompt().catch(() => {});
			await this.closeClient(client);
		}));
		await Promise.allSettled([
			...this.ensureSessionLocks.values(),
			...this.runtimeOperationLocks.values(),
			...this.pendingTasks
		]);
		const owners = /* @__PURE__ */ new Set([...this.retainedSessionOwners.values(), ...this.retiringSessionOwners]);
		const stopped = await Promise.allSettled([...owners].map(async (owner) => {
			this.removeRetainedSessionOwner(owner);
			const retirement = owner.retirement;
			if (retirement) await retirement;
			else {
				const failure = await this.stopSessionOwner(owner);
				if (failure) throw failure.error;
			}
			this.retiringSessionOwners.delete(owner);
		}));
		const errors = [];
		for (const result of [...closed, ...stopped]) if (result.status === "rejected") errors.push(result.reason);
		if (errors.length) throw new AggregateError(errors, "ACP runtime shutdown failed.");
	}
	trackTask(task) {
		this.pendingTasks.add(task);
		const remove = () => {
			this.pendingTasks.delete(task);
		};
		task.then(remove, remove);
		return task;
	}
	queueSessionTask(recordId, run, cancel) {
		const tasks = this.sessionTasks.get(recordId) ?? /* @__PURE__ */ new Set();
		this.sessionTasks.set(recordId, tasks);
		const previous = [...tasks].at(-1)?.completion;
		const result = (async () => {
			await previous?.catch(() => {});
			return await run();
		})();
		const task = {
			completion: result.then(() => {}),
			cancel
		};
		task.completion.catch(() => {});
		tasks.add(task);
		const remove = () => {
			tasks.delete(task);
			if (tasks.size === 0) this.sessionTasks.delete(recordId);
		};
		result.then(remove, remove);
		return this.trackTask(result);
	}
	async cancelSessionTasks(recordId) {
		const tasks = [...this.sessionTasks.get(recordId) ?? []];
		await Promise.all(tasks.flatMap((task) => task.cancel ? [task.cancel()] : []));
		return tasks;
	}
	async closeClient(client) {
		await client.close();
		this.liveClients.delete(client);
	}
	createSessionOwner(input) {
		const owner = {
			...input,
			checkpoint: new LiveSessionCheckpoint({ save: async () => this.saveSessionOwner(owner) }),
			bufferSessionUpdates: false,
			pendingSessionUpdates: []
		};
		input.client.setEventHandlers({
			onSessionUpdate: (notification) => this.routeOwnedSessionUpdate(owner, notification),
			onClientOperation: (operation) => this.routeOwnedClientOperation(owner, operation)
		});
		return owner;
	}
	async saveSessionOwner(owner) {
		if (!owner.recordId || owner.pendingResetRecord) return;
		const active = owner.activeTurn?.turn;
		const target = active ?? owner.projection;
		if (!target) return;
		const { record, conversation } = target;
		if (active?.connected) record.acpx = active.acpxState;
		record.lastUsedAt = isoNow();
		applyConversation(record, conversation);
		applyLifecycleSnapshotToRecord(record, owner.client.getAgentLifecycleSnapshot());
		await this.refreshClosedState(record);
		await this.options.sessionStore.save(record);
	}
	routeOwnedSessionUpdate(owner, notification) {
		const active = owner.activeTurn;
		if (active) {
			const { task, turn } = active;
			if (turn.connected) {
				turn.acpxState = recordSessionUpdate(turn.conversation, turn.acpxState, notification);
				owner.checkpoint.request();
			} else turn.record.acpx = recordSessionUpdate(turn.conversation, turn.record.acpx, notification);
			trimConversationForRuntime(turn.conversation);
			this.emitRuntimeTurnEvent(task, {
				jsonrpc: "2.0",
				method: "session/update",
				params: notification
			});
			return;
		}
		if (owner.bufferSessionUpdates) {
			owner.pendingSessionUpdates.push(notification);
			return;
		}
		const projection = owner.projection;
		if (!projection) {
			owner.pendingSessionUpdates.push(notification);
			return;
		}
		projection.record.acpx = recordSessionUpdate(projection.conversation, projection.record.acpx, notification);
		trimConversationForRuntime(projection.conversation);
		owner.checkpoint.request();
	}
	routeOwnedClientOperation(owner, operation) {
		const active = owner.activeTurn;
		if (!active) return;
		const { task, turn } = active;
		if (turn.connected) {
			turn.acpxState = recordClientOperation(turn.conversation, turn.acpxState, operation);
			owner.checkpoint.request();
		} else turn.record.acpx = recordClientOperation(turn.conversation, turn.record.acpx, operation);
		trimConversationForRuntime(turn.conversation);
		this.emitRuntimeTurnEvent(task, {
			type: "client_operation",
			...operation
		});
	}
	attachIdleProjection(owner, record, conversation = cloneSessionConversation(record), acpxState = record.acpx) {
		record.acpx = acpxState;
		owner.projection = {
			record,
			conversation
		};
		owner.activeTurn = void 0;
		this.drainPendingSessionUpdates(owner);
	}
	drainPendingSessionUpdates(owner) {
		for (const notification of owner.pendingSessionUpdates.splice(0)) this.routeOwnedSessionUpdate(owner, notification);
	}
	async flushSessionOwner(owner) {
		await owner.client.waitForSessionUpdatesIdle?.().catch(() => {});
		await owner.checkpoint.flush();
	}
	removeRetainedSessionOwner(owner) {
		if (owner.recordId && this.retainedSessionOwners.get(owner.recordId) === owner) this.retainedSessionOwners.delete(owner.recordId);
		if (owner.mode === "oneshot" && owner.recordId && this.pendingOneShotRecordIds.get(owner.sessionKey) === owner.recordId) this.pendingOneShotRecordIds.delete(owner.sessionKey);
	}
	async readRetainedSessionOwner(record, options) {
		const owner = this.retainedSessionOwners.get(record.acpxRecordId);
		if (!owner) return;
		await this.flushSessionOwner(owner);
		const projectedRecord = owner.projection?.record;
		if (projectedRecord && projectedRecord !== record) Object.assign(record, structuredClone(projectedRecord));
		if (!owner.client.hasReusableSession(record.acpSessionId)) {
			this.removeRetainedSessionOwner(owner);
			await this.stopSessionOwner(owner);
			return;
		}
		if (options.consume) this.removeRetainedSessionOwner(owner);
		return owner;
	}
	async closeRetainedSessionOwner(recordId) {
		const owner = this.retainedSessionOwners.get(recordId);
		if (!owner) return;
		this.removeRetainedSessionOwner(owner);
		await this.stopSessionOwner(owner);
	}
	async stopSessionOwner(owner) {
		const flushAttempt = await settleAttempt(async () => this.flushSessionOwner(owner));
		const closeAttempt = await settleAttempt(async () => this.closeClient(owner.client));
		if (!closeAttempt.ok) this.retiringSessionOwners.add(owner);
		const finalFlushAttempt = await settleAttempt(async () => owner.checkpoint.flush());
		const clearAttempt = await settleAttempt(() => owner.client.clearEventHandlers());
		const settleRecordAttempt = await settleAttempt(async () => {
			if (closeAttempt.ok) await this.settleRetiredSessionRecord(owner);
		});
		if (!settleRecordAttempt.ok) this.retiringSessionOwners.add(owner);
		return firstFailedAttempt([
			flushAttempt,
			closeAttempt,
			finalFlushAttempt,
			clearAttempt,
			settleRecordAttempt
		]);
	}
	async retrySessionCleanup(recordId) {
		for (const owner of this.retiringSessionOwners) if (owner.recordId === recordId) {
			owner.retirement ??= this.finalizeSessionConnection({
				client: owner.client,
				owner
			}).then(async () => {
				await this.settleRetiredSessionRecord(owner);
				this.retiringSessionOwners.delete(owner);
			}).finally(() => {
				owner.retirement = void 0;
			});
			await owner.retirement;
		}
	}
	async refreshClosedState(record) {
		if (!this.closingActiveRecords.has(record.acpxRecordId)) return record.closed === true;
		const latest = await this.options.sessionStore.load(record.acpxRecordId).catch(() => void 0);
		record.closed = true;
		record.closedAt = latest?.closedAt ?? record.closedAt ?? isoNow();
		if (latest?.acpx?.reset_on_next_ensure === true) record.acpx = {
			...record.acpx,
			reset_on_next_ensure: true
		};
		return true;
	}
	async retainPersistentSessionOwnerAfterTurn(input) {
		const { record, owner } = input;
		if (!this.canRetainPersistentSessionOwner(owner, record)) return false;
		const previousOwner = this.retainedSessionOwners.get(record.acpxRecordId);
		this.retainedSessionOwners.set(record.acpxRecordId, owner);
		if (previousOwner && previousOwner !== owner) {
			this.removeRetainedSessionOwner(previousOwner);
			await this.stopSessionOwner(previousOwner);
		}
		return true;
	}
	canRetainPersistentSessionOwner(owner, record) {
		return !this.shuttingDown && owner.mode === "persistent" && !record.closed && !(owner.client.hasUnresolvedPrompt?.() ?? false) && owner.client.hasReusableSession(record.acpSessionId);
	}
	resolveMcpServers(session) {
		const servers = this.options.mcpServers;
		const { sessionKey, cwd, agentCommand, agentArgv } = session;
		return [...typeof servers === "function" ? servers({
			sessionKey,
			cwd,
			agentCommand,
			agentArgv: agentArgv ? [...agentArgv] : void 0
		}) : servers ?? []];
	}
	resolveSessionPermissions(session) {
		const { sessionKey, cwd, agentCommand, agentArgv } = session;
		const { permissionMode = this.options.permissionMode, nonInteractivePermissions = this.options.nonInteractivePermissions, permissionPolicy = this.options.permissionPolicy, onPermissionRequest = this.options.onPermissionRequest } = this.options.sessionPermissions?.({
			sessionKey,
			cwd,
			agentCommand,
			agentArgv: agentArgv ? [...agentArgv] : void 0
		}) ?? {};
		return {
			permissionMode,
			nonInteractivePermissions,
			permissionPolicy,
			onPermissionRequest
		};
	}
	resolveClientCapabilities() {
		return {
			fs: this.options.fs,
			terminal: this.options.terminal
		};
	}
	async withRuntimeControlSession(record, sessionMode, run, replayOptions, authority) {
		await this.retrySessionCleanup(record.acpxRecordId);
		assertControlAuthority(authority);
		const owner = await this.readRetainedSessionOwner(record, { consume: false });
		assertControlAuthority(authority);
		if (owner) {
			const ownedRecord = owner.projection?.record ?? record;
			try {
				const value = await run({
					client: owner.client,
					sessionId: ownedRecord.acpSessionId,
					record: ownedRecord
				});
				this.refreshOwnedRecordLifecycle(owner, ownedRecord);
				await owner.checkpoint.checkpoint();
				return value;
			} finally {
				await this.flushSessionOwner(owner);
			}
		}
		let controlClient;
		let controlledRecord = record;
		const checkpoint = new LiveSessionCheckpoint({ save: async () => this.options.sessionStore.save(controlledRecord) });
		try {
			const result = await settleAttempt(async () => withConnectedSession({
				sessionRecordId: record.acpxRecordId,
				loadRecord: async (sessionRecordId) => {
					controlledRecord = await this.requireRecord(sessionRecordId);
					this.controlSessionRecords.set(sessionRecordId, {
						record: controlledRecord,
						checkpoint
					});
					return controlledRecord;
				},
				saveRecord: async () => checkpoint.checkpoint(),
				createClient: (options) => controlClient = this.createClient({
					...options,
					processLifecycle: this.options.processLifecycle,
					processLaunchScope: {
						kind: "runtime-session",
						sessionKey: record.name ?? record.acpxRecordId
					}
				}),
				mcpServers: this.resolveMcpServers({
					...record,
					sessionKey: record.name ?? record.acpxRecordId
				}),
				...this.resolveSessionPermissions({
					...record,
					sessionKey: record.name ?? record.acpxRecordId
				}),
				...this.resolveClientCapabilities(),
				elicitationModes: this.options.elicitationModes,
				verbose: this.options.verbose,
				timeoutMs: this.options.timeoutMs,
				resumePolicy: resumePolicyForSessionMode(sessionMode),
				replacingMode: replayOptions?.replacingMode,
				replacingConfigOption: replayOptions?.replacingConfigOption,
				authority,
				run
			}));
			this.controlSessionRecords.delete(record.acpxRecordId);
			const flushed = await settleAttempt(async () => checkpoint.flush());
			if (!result.ok) throw result.error;
			if (!flushed.ok) throw flushed.error;
			return result.value.value;
		} finally {
			this.controlSessionRecords.delete(record.acpxRecordId);
			if (controlClient) this.liveClients.delete(controlClient);
		}
	}
	refreshOwnedRecordLifecycle(owner, record) {
		record.lastUsedAt = isoNow();
		record.closed = false;
		record.closedAt = void 0;
		record.protocolVersion = owner.client.initializeResult?.protocolVersion;
		record.agentCapabilities = owner.client.initializeResult?.agentCapabilities;
		applyLifecycleSnapshotToRecord(record, owner.client.getAgentLifecycleSnapshot());
	}
	async ensureSession(input) {
		return await this.withEnsureSessionLock(input, async () => this.ensureSessionWithOwnership(input));
	}
	async withEnsureSessionLock(input, run) {
		const key = `${input.mode}\0${input.sessionKey}`;
		return await this.withManagerLock(this.ensureSessionLocks, key, run);
	}
	async withManagerLock(locks, key, run, authority) {
		this.assertOpen();
		assertControlAuthority(authority);
		return await this.serializeManagerOperation(locks, key, async () => {
			this.assertOpen();
			assertControlAuthority(authority);
			return await run();
		});
	}
	async serializeManagerOperation(locks, key, run) {
		const previous = locks.get(key) ?? Promise.resolve();
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => gate);
		locks.set(key, tail);
		await previous;
		try {
			return await run();
		} finally {
			release();
			if (locks.get(key) === tail) locks.delete(key);
		}
	}
	async ensureSessionWithOwnership(input) {
		const cwd = path.resolve(input.cwd?.trim() || this.options.cwd);
		const { agentCommand, agentArgv } = normalizeAgentCommandInput(this.options.agentRegistry.resolve(input.agent));
		const agent = {
			cwd,
			agentCommand,
			agentArgv
		};
		if (input.mode !== "persistent") return await this.acquireRuntimeSession(input, agent);
		const compatible = await this.reuseCompatiblePersistentSession(input, agent);
		if (compatible) return compatible;
		this.assertRuntimeSessionIdle(input.sessionKey);
		return await this.withManagerLock(this.runtimeOperationLocks, input.sessionKey, async () => this.acquireRuntimeSession(input, agent));
	}
	async reuseCompatiblePersistentSession(input, agent) {
		await this.retrySessionCleanup(input.sessionKey);
		const controlled = this.controlSessionRecords.get(input.sessionKey);
		const record = controlled ? controlled.record : await this.findSession(input.sessionKey);
		if (!record || this.closingActiveRecords.has(input.sessionKey) || !shouldReuseExistingRecord(record, {
			...agent,
			resumeSessionId: input.resumeSessionId
		})) return;
		if (!record.closed) return record;
		if (!controlled || this.sessionTasks.has(input.sessionKey)) return;
		return await this.reuseRuntimeSession({ record }, controlled.checkpoint);
	}
	async acquireRuntimeSession(input, agent) {
		const existing = await this.loadExistingRuntimeSession(input);
		if (existing && this.canReuseRuntimeSession(input, agent, existing)) return await this.reuseRuntimeSession(existing);
		await this.closeConflictingPersistentSession(input, existing?.owner);
		return await this.createOwnedRuntimeSession(input, agent);
	}
	async loadExistingRuntimeSession(input) {
		const existingRecordId = input.mode === "persistent" ? input.sessionKey : this.pendingOneShotRecordIds.get(input.sessionKey);
		if (!existingRecordId) return;
		await this.retrySessionCleanup(existingRecordId);
		let record = await this.findSession(existingRecordId);
		if (!record) return;
		const owner = this.retainedSessionOwners.get(record.acpxRecordId);
		if (owner) {
			await this.flushSessionOwner(owner);
			record = owner.projection?.record ?? record;
		}
		return {
			record,
			owner
		};
	}
	async findSession(sessionKey) {
		return await this.options.sessionStore.load(sessionKey);
	}
	canReuseRuntimeSession(input, agent, existing) {
		if (!shouldReuseExistingRecord(existing.record, {
			cwd: agent.cwd,
			agentCommand: agent.agentCommand,
			agentArgv: agent.agentArgv,
			resumeSessionId: input.resumeSessionId
		})) return false;
		if (input.mode === "persistent") return true;
		return Boolean(existing.owner && !existing.record.closed && this.pendingOneShotRecordIds.get(input.sessionKey) === existing.record.acpxRecordId && this.retainedSessionOwners.get(existing.record.acpxRecordId) === existing.owner && isDeepStrictEqual(sessionOptionsFromRecord(existing.record), normalizeSessionOptionShape(input.sessionOptions)));
	}
	assertRuntimeSessionIdle(recordId) {
		if (this.sessionTasks.has(recordId) || this.runtimeOperationLocks.has(recordId)) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", `Cannot ensure session ${recordId} with incompatible or closing state while its work is unfinished. Wait for existing work to finish or use a different session key.`);
	}
	async reuseRuntimeSession({ record, owner }, checkpoint = owner?.checkpoint) {
		if (!record.closed && !this.closingActiveRecords.has(record.acpxRecordId)) return record;
		record.closed = false;
		record.closedAt = void 0;
		this.closingActiveRecords.delete(record.acpxRecordId);
		if (checkpoint) await checkpoint.checkpoint();
		else await this.options.sessionStore.save(record);
		return record;
	}
	async closeConflictingPersistentSession(input, owner) {
		if (input.mode === "persistent" && owner?.recordId) {
			this.removeRetainedSessionOwner(owner);
			this.retiringSessionOwners.add(owner);
			await this.retrySessionCleanup(owner.recordId);
		}
	}
	async createOwnedRuntimeSession(input, agent) {
		const { cwd, agentCommand, agentArgv } = agent;
		const client = this.createClient({
			agentCommand,
			agentArgv,
			cwd,
			mcpServers: this.resolveMcpServers({
				...agent,
				sessionKey: input.sessionKey
			}),
			...this.resolveSessionPermissions({
				...agent,
				sessionKey: input.sessionKey
			}),
			...this.resolveClientCapabilities(),
			elicitationModes: this.options.elicitationModes,
			processLifecycle: this.options.processLifecycle,
			processLaunchScope: {
				kind: "runtime-session",
				sessionKey: input.sessionKey
			},
			verbose: this.options.verbose,
			sessionOptions: input.sessionOptions
		});
		const owner = this.createSessionOwner({
			client,
			sessionKey: input.sessionKey,
			mode: input.mode
		});
		try {
			await startRuntimeClient(client, agent, this.options.timeoutMs);
			this.assertOpen();
			const session = await createOrLoadRuntimeSession(client, input.resumeSessionId, cwd);
			const record = await this.prepareInitialRuntimeRecord({
				input,
				client,
				owner,
				agentCommand,
				agentArgv,
				cwd,
				session
			});
			await this.retainInitializedSessionOwner(owner, record);
			return record;
		} catch (error) {
			await settleAttempt(async () => this.abandonInitializingSessionOwner(owner));
			throw error;
		}
	}
	async abandonInitializingSessionOwner(owner) {
		const record = owner.recordId ? owner.projection?.record : void 0;
		owner.pendingResetRecord = record;
		await settleAttempt(() => owner.client.clearEventHandlers());
		const closeAttempt = await settleAttempt(async () => this.closeClient(owner.client));
		if (!record) return;
		this.retiringSessionOwners.add(owner);
		if (closeAttempt.ok) {
			await this.settleRetiredSessionRecord(owner);
			this.retiringSessionOwners.delete(owner);
		}
	}
	async settleRetiredSessionRecord(owner) {
		const record = owner.pendingResetRecord;
		if (!record) return;
		applyLifecycleSnapshotToRecord(record, owner.client.getAgentLifecycleSnapshot());
		await this.saveClosedRuntimeRecord(record, true);
		owner.pendingResetRecord = void 0;
		owner.recordId = void 0;
	}
	async prepareInitialRuntimeRecord(params) {
		const { input, client, owner, agentCommand, agentArgv, cwd, session } = params;
		const record = createInitialSessionRecord({
			recordId: createRecordId(input.sessionKey, input.mode),
			name: input.sessionKey,
			sessionId: session.sessionId,
			sessionOrigin: input.resumeSessionId ? "resume" : "new",
			agentCommand,
			agentArgv,
			cwd,
			agentSessionId: session.agentSessionId
		});
		this.closingActiveRecords.delete(record.acpxRecordId);
		record.protocolVersion = client.initializeResult?.protocolVersion;
		record.agentCapabilities = client.initializeResult?.agentCapabilities;
		this.attachIdleProjection(owner, record);
		applyConfigOptionsToRecord(record, session.sessionResult);
		const modelApplication = await applyRequestedModelIfAdvertised({
			client,
			sessionId: session.sessionId,
			requestedModel: input.sessionOptions?.model,
			models: session.sessionResult.models,
			agentCommand,
			timeoutMs: this.options.timeoutMs
		});
		applyInitialModelSelection(record, session.sessionResult.models, modelApplication);
		applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
		persistSessionOptions(record, input.sessionOptions);
		return record;
	}
	async retainInitializedSessionOwner(owner, record) {
		owner.recordId = record.acpxRecordId;
		await owner.checkpoint.checkpoint();
		this.assertOpen();
		const previousOwner = this.retainedSessionOwners.get(record.acpxRecordId);
		this.retainedSessionOwners.set(record.acpxRecordId, owner);
		if (owner.mode === "oneshot") this.pendingOneShotRecordIds.set(owner.sessionKey, record.acpxRecordId);
		if (previousOwner && previousOwner !== owner) {
			this.removeRetainedSessionOwner(previousOwner);
			await this.stopSessionOwner(previousOwner);
		}
	}
	startTurn(input) {
		this.assertOpen();
		let promptInput;
		try {
			promptInput = toPromptInput(input.text, input.attachments);
		} catch (error) {
			this.trackTask(this.closeRetainedOneShotHandle(input.handle).catch(() => {}));
			throw error;
		}
		const queue = new AsyncEventQueue();
		const result = createDeferred();
		const promptStarted = createDeferred();
		promptStarted.promise.catch(() => {});
		const sessionReady = createDeferred();
		sessionReady.promise.catch(() => {});
		let resultSettled = false;
		const state = {
			pendingCancel: false,
			turnActive: true,
			activeController: null
		};
		let streamClosed = false;
		const settleResult = (next) => {
			if (resultSettled) return;
			resultSettled = true;
			result.resolve(next);
		};
		const closeStream = () => {
			if (streamClosed) return;
			streamClosed = true;
			queue.clear();
			queue.close();
		};
		const requestCancel = async () => {
			if (state.activeController) return await state.activeController.requestCancelActivePrompt();
			if (!state.turnActive) return false;
			state.pendingCancel = true;
			return true;
		};
		const abortHandler = () => {
			requestCancel().catch(() => {});
		};
		if (input.signal && !input.signal.aborted) input.signal.addEventListener("abort", abortHandler, { once: true });
		this.queueSessionTask(input.handle.acpxRecordId ?? input.handle.sessionKey, async () => this.runRuntimeTurnTask({
			input,
			promptInput,
			queue,
			promptStarted,
			sessionReady,
			state,
			settleResult,
			abortHandler
		}), requestCancel);
		return {
			requestId: input.requestId,
			promptStarted: promptStarted.promise,
			events: queue.iterate(),
			result: result.promise,
			cancel: async () => {
				await requestCancel();
			},
			closeStream: async () => {
				closeStream();
			}
		};
	}
	async closeRetainedOneShotHandle(handle) {
		const recordId = handle.acpxRecordId ?? handle.sessionKey;
		await this.serializeManagerOperation(this.runtimeOperationLocks, recordId, async () => {
			if (this.retainedSessionOwners.get(recordId)?.mode === "oneshot") await this.closeRetainedSessionOwner(recordId);
		});
	}
	async runRuntimeTurnTask(task) {
		let turn;
		let terminalResult;
		try {
			if (this.cancelRuntimeTurnBeforePrompt(task)) {
				await this.closeRetainedOneShotHandle(task.input.handle);
				terminalResult = {
					status: "cancelled",
					stopReason: "cancelled"
				};
			} else {
				turn = await this.prepareRuntimeTurn(task);
				const { sessionId } = await this.connectRuntimeTurn(task, turn);
				this.assertOpen();
				await this.resolveRuntimeTurnReady(task, turn);
				if (this.cancelRuntimeTurnBeforePrompt(task)) terminalResult = {
					status: "cancelled",
					stopReason: "cancelled"
				};
				else {
					const response = await this.runRuntimePrompt(task, turn, sessionId);
					this.updateCompletedRuntimeTurn(turn);
					terminalResult = {
						status: response.stopReason === "cancelled" ? "cancelled" : "completed",
						...response.stopReason ? { stopReason: response.stopReason } : {},
						...response._meta === void 0 ? {} : { _meta: response._meta }
					};
				}
			}
		} catch (error) {
			terminalResult = this.handleRuntimeTurnFailure(task, error);
		}
		const finalization = await settleAttempt(async () => this.serializeManagerOperation(this.runtimeOperationLocks, task.input.handle.acpxRecordId ?? task.input.handle.sessionKey, async () => this.finalizeRuntimeTurn(task, turn)));
		if (!finalization.ok) {
			task.settleResult(this.failRuntimeTurn(task, finalization.error));
			throw finalization.error;
		}
		task.settleResult(terminalResult);
	}
	async runRuntimePrompt(task, turn, sessionId) {
		return await runPromptTurn({
			client: turn.client,
			sessionId,
			prompt: task.promptInput,
			timeoutMs: task.input.timeoutMs ?? this.options.timeoutMs,
			conversation: turn.conversation,
			promptMessageId: turn.promptMessageId,
			onPromptRequestWritten: () => task.promptStarted.resolve(),
			onElicitation: task.input.onElicitation,
			onPermissionRequest: task.input.onPermissionRequest,
			authority: task.input
		});
	}
	async prepareRuntimeTurn(task) {
		const recordId = task.input.handle.acpxRecordId ?? task.input.handle.sessionKey;
		return await this.withManagerLock(this.runtimeOperationLocks, recordId, async () => {
			await this.retrySessionCleanup(recordId);
			return await this.prepareRuntimeTurnWithOwnership(task);
		});
	}
	async prepareRuntimeTurnWithOwnership(task) {
		const { record, retainedOwner, conversation, acpxState, promptMessageId } = await this.prepareRuntimeTurnState(task);
		try {
			const client = retainedOwner?.client ?? this.createTurnClient(record);
			const owner = this.resolveRuntimeTurnOwner(task, record, client, retainedOwner);
			const turn = this.createRunningRuntimeTurn({
				record,
				conversation,
				acpxState,
				client,
				owner,
				connected: retainedOwner !== void 0,
				promptMessageId
			});
			this.activateRuntimeTurn(task, turn);
			return turn;
		} catch (error) {
			this.restoreBufferedSessionOwner(retainedOwner);
			throw error;
		}
	}
	async prepareRuntimeTurnState(task) {
		const { record, retainedOwner } = await this.acquireRuntimeTurnState(task);
		const conversation = cloneSessionConversation(record);
		const acpxState = cloneSessionAcpxState(record.acpx);
		try {
			const promptStartedAt = isoNow();
			const promptMessageId = recordPromptSubmission(conversation, task.promptInput, promptStartedAt);
			trimConversationForRuntime(conversation);
			record.lastPromptAt = promptStartedAt;
			record.lastUsedAt = promptStartedAt;
			record.acpx = acpxState;
			applyConversation(record, conversation);
			await this.options.sessionStore.save(record);
			return {
				record,
				retainedOwner,
				conversation,
				acpxState,
				promptMessageId
			};
		} catch (error) {
			this.restoreBufferedSessionOwner(retainedOwner);
			throw error;
		}
	}
	async acquireRuntimeTurnState(task) {
		const recordId = task.input.handle.acpxRecordId ?? task.input.handle.sessionKey;
		let record = await this.requireRecord(recordId);
		const retainedOwner = await this.readRetainedSessionOwner(record, { consume: false });
		if (!retainedOwner) return { record };
		retainedOwner.bufferSessionUpdates = true;
		try {
			await retainedOwner.checkpoint.flush();
			const projection = retainedOwner.projection;
			if (projection) record = structuredClone(projection.record);
			return {
				record,
				retainedOwner
			};
		} catch (error) {
			this.restoreBufferedSessionOwner(retainedOwner);
			throw error;
		}
	}
	restoreBufferedSessionOwner(owner) {
		if (!owner) return;
		owner.bufferSessionUpdates = false;
		this.drainPendingSessionUpdates(owner);
	}
	resolveRuntimeTurnOwner(task, record, client, retainedOwner) {
		return retainedOwner ?? this.createSessionOwner({
			client,
			sessionKey: record.name ?? task.input.handle.sessionKey,
			mode: task.input.sessionMode
		});
	}
	createRunningRuntimeTurn(input) {
		const { record, conversation, acpxState, client, owner, connected, promptMessageId } = input;
		return {
			record,
			conversation,
			acpxState,
			client,
			owner,
			connected,
			promptMessageId,
			activeSessionId: record.acpSessionId
		};
	}
	activateRuntimeTurn(task, turn) {
		const { owner, record } = turn;
		this.removeRetainedSessionOwner(owner);
		owner.recordId = record.acpxRecordId;
		task.state.activeController = this.buildRuntimeTurnController(task, turn);
		this.activeControllers.set(record.acpxRecordId, task.state.activeController);
		owner.projection = void 0;
		owner.activeTurn = {
			task,
			turn
		};
		owner.bufferSessionUpdates = false;
		this.drainPendingSessionUpdates(owner);
	}
	createTurnClient(record) {
		return this.createClient({
			agentCommand: record.agentCommand,
			agentArgv: record.agentArgv,
			cwd: record.cwd,
			mcpServers: this.resolveMcpServers({
				...record,
				sessionKey: record.name ?? record.acpxRecordId
			}),
			...this.resolveSessionPermissions({
				...record,
				sessionKey: record.name ?? record.acpxRecordId
			}),
			...this.resolveClientCapabilities(),
			elicitationModes: this.options.elicitationModes,
			processLifecycle: this.options.processLifecycle,
			processLaunchScope: {
				kind: "runtime-session",
				sessionKey: record.name ?? record.acpxRecordId
			},
			verbose: this.options.verbose,
			sessionOptions: sessionOptionsFromRecord(record)
		});
	}
	buildRuntimeTurnController(task, turn) {
		return {
			hasActivePrompt: () => turn.client.hasActivePrompt(),
			requestCancelActivePrompt: async () => await this.requestRuntimeTurnCancel(task, turn),
			setSessionMode: async (modeId, authority) => {
				await this.waitForRuntimeControlSession(task, turn);
				await turn.client.setSessionMode(turn.activeSessionId, modeId, authority);
				const nextState = cloneSessionAcpxState(turn.acpxState) ?? {};
				nextState.desired_mode_id = modeId;
				turn.acpxState = nextState;
				await turn.owner.checkpoint.checkpoint();
			},
			setSessionModel: async (modelId, authority) => {
				await this.waitForRuntimeControlSession(task, turn);
				const models = advertisedModelState(turn.acpxState);
				const resolvedModelId = resolveRequestedModelId({
					requestedModel: modelId,
					models,
					agentCommand: turn.record.agentCommand
				});
				const response = await turn.client.setSessionModel(turn.activeSessionId, modelId, models, authority);
				turn.acpxState = applyModelSelection(turn.acpxState, modelId, response, resolvedModelId);
				await turn.owner.checkpoint.checkpoint();
				return response;
			},
			setSessionConfigOption: async (configId, value, authority) => {
				return (await task.state.activeController.setResolvedSessionConfigOption(configId, value, authority)).response;
			},
			setResolvedSessionConfigOption: async (configId, value, authority) => await this.setRuntimeResolvedSessionConfigOption(task, turn, configId, value, authority)
		};
	}
	async waitForRuntimeControlSession(task, turn) {
		if (turn.client.hasActivePrompt()) return;
		await task.sessionReady.promise;
	}
	async requestRuntimeTurnCancel(task, turn) {
		if (turn.client.hasActivePrompt()) return await turn.client.requestCancelActivePrompt();
		if (!task.state.turnActive) return false;
		task.state.pendingCancel = true;
		return true;
	}
	async setRuntimeResolvedSessionConfigOption(task, turn, configId, value, authority) {
		await this.waitForRuntimeControlSession(task, turn);
		const resolvedConfigId = resolveSupportedConfigOptionId({
			...turn.record,
			acpx: turn.acpxState ?? void 0
		}, configId);
		const models = advertisedModelState(turn.acpxState);
		const { modelConfigId, resolvedValue } = resolveRequestedConfigOption({
			configId: resolvedConfigId,
			value,
			models,
			agentCommand: turn.record.agentCommand
		});
		const response = await turn.client.setSessionConfigOption(turn.activeSessionId, resolvedConfigId, value, models, authority);
		turn.acpxState = applyConfigOptionSelection(turn.acpxState, resolvedConfigId, value, response, modelConfigId, resolvedValue);
		await turn.owner.checkpoint.checkpoint();
		return {
			configId: resolvedConfigId,
			response
		};
	}
	emitRuntimeTurnEvent(task, payload) {
		const parsed = parsePromptEventLine(JSON.stringify(payload));
		if (!parsed) return;
		task.queue.push(parsed);
	}
	async connectRuntimeTurn(task, turn) {
		if (turn.connected) return {
			sessionId: turn.record.acpSessionId,
			resumed: false,
			loadError: void 0
		};
		const loaded = await this.connectRuntimeTurnClient(task, turn);
		turn.acpxState = cloneSessionAcpxState(turn.record.acpx);
		turn.connected = true;
		return loaded;
	}
	async connectRuntimeTurnClient(task, turn) {
		return await connectAndLoadSession({
			client: turn.client,
			record: turn.record,
			resumePolicy: resumePolicyForSessionMode(task.input.sessionMode),
			timeoutMs: this.options.timeoutMs,
			promptRecorded: true,
			activeController: task.state.activeController,
			onClientAvailable: () => this.publishRuntimeTurnController(task, turn),
			onConnectedRecord: (connectedRecord) => {
				connectedRecord.lastPromptAt = isoNow();
			},
			onSessionIdResolved: (sessionIdValue) => {
				turn.activeSessionId = sessionIdValue;
			}
		});
	}
	publishRuntimeTurnController(task, turn) {
		const controller = task.state.activeController;
		if (controller) this.activeControllers.set(turn.record.acpxRecordId, controller);
	}
	async resolveRuntimeTurnReady(task, turn) {
		task.sessionReady.resolve();
		turn.record.lastRequestId = task.input.requestId;
		turn.record.lastPromptAt = isoNow();
		turn.record.closed = false;
		turn.record.closedAt = void 0;
		turn.record.lastUsedAt = isoNow();
		await turn.owner.checkpoint.checkpoint();
	}
	cancelRuntimeTurnBeforePrompt(task) {
		if (!task.state.pendingCancel && !task.input.signal?.aborted) return false;
		task.state.pendingCancel = false;
		task.promptStarted.reject(/* @__PURE__ */ new Error("ACP turn cancelled before prompt submission."));
		return true;
	}
	updateCompletedRuntimeTurn(turn) {
		turn.record.acpSessionId = turn.activeSessionId;
		reconcileAgentSessionId(turn.record, turn.record.agentSessionId);
		turn.record.protocolVersion = turn.client.initializeResult?.protocolVersion;
		turn.record.agentCapabilities = turn.client.initializeResult?.agentCapabilities;
	}
	handleRuntimeTurnFailure(task, error) {
		if (!task.input.signal?.aborted || error !== task.input.signal.reason) return this.failRuntimeTurn(task, error);
		task.promptStarted.reject(error);
		task.sessionReady.reject(error);
		return {
			status: "cancelled",
			stopReason: "cancelled"
		};
	}
	failRuntimeTurn(task, error) {
		task.promptStarted.reject(error);
		task.sessionReady.reject(error);
		const normalized = normalizeOutputError(error, { origin: "runtime" });
		return {
			status: "failed",
			error: {
				message: normalized.message,
				...normalized.code ? { code: normalized.code } : {},
				...normalized.detailCode ? { detailCode: normalized.detailCode } : {},
				...normalized.retryable !== void 0 ? { retryable: normalized.retryable } : {}
			}
		};
	}
	async finalizeRuntimeTurn(task, turn) {
		task.state.turnActive = false;
		const abortHandlerAttempt = await settleAttempt(() => task.input.signal?.removeEventListener("abort", task.abortHandler));
		const recordAttempt = await settleAttempt(async () => turn ? await this.finalizeRuntimeTurnRecord(turn) : false);
		let failure = firstFailedAttempt([abortHandlerAttempt, recordAttempt]);
		let pooled = recordAttempt.ok ? recordAttempt.value : false;
		if (failure) {
			this.discardRetainedRuntimeTurnOwner(turn);
			pooled = false;
		}
		const closeAttempt = await settleAttempt(async () => this.closeRuntimeTurnClient(turn, pooled));
		this.cleanupRuntimeTurn(task, turn);
		failure ??= firstFailedAttempt([closeAttempt]);
		if (failure) throw failure.error;
	}
	discardRetainedRuntimeTurnOwner(turn) {
		if (turn) {
			this.removeRetainedSessionOwner(turn.owner);
			this.attachFinalRuntimeProjection(turn);
		}
	}
	attachFinalRuntimeProjection(turn) {
		const current = turn.connected ? turn.acpxState : turn.record.acpx;
		const state = turn.record.acpx?.reset_on_next_ensure === true ? {
			...current,
			reset_on_next_ensure: true
		} : current;
		this.attachIdleProjection(turn.owner, turn.record, turn.conversation, state);
	}
	async closeRuntimeTurnClient(turn, pooled) {
		if (!turn || pooled) return;
		const failure = firstFailedAttempt([
			await settleAttempt(() => turn.client.clearEventHandlers()),
			await settleAttempt(async () => this.closeClient(turn.client)),
			await settleAttempt(async () => this.flushSessionOwner(turn.owner))
		]);
		if (failure) {
			this.retiringSessionOwners.add(turn.owner);
			throw failure.error;
		}
	}
	cleanupRuntimeTurn(task, turn) {
		if (turn) {
			this.activeControllers.delete(turn.record.acpxRecordId);
			this.closingActiveRecords.delete(turn.record.acpxRecordId);
		}
		task.queue.close();
	}
	async finalizeRuntimeTurnRecord(turn) {
		if (!turn.connected) turn.acpxState = cloneSessionAcpxState(turn.record.acpx);
		await turn.owner.checkpoint.checkpoint();
		this.attachFinalRuntimeProjection(turn);
		if (turn.record.closed || !turn.connected) return false;
		return await this.retainPersistentSessionOwnerAfterTurn({
			record: turn.record,
			owner: turn.owner
		});
	}
	async *runTurn(input) {
		const turn = this.startTurn(input);
		yield* turn.events;
		yield legacyTerminalEventFromTurnResult(await turn.result);
	}
	getStatus(handle) {
		this.assertOpen();
		return this.trackTask(this.readStatus(handle));
	}
	async readStatus(handle) {
		const recordId = handle.acpxRecordId ?? handle.sessionKey;
		const owner = this.retainedSessionOwners.get(recordId);
		if (owner) await this.flushSessionOwner(owner);
		return runtimeStatusFromRecord(await this.requireRecord(recordId));
	}
	async setMode(handle, mode, sessionMode = "persistent", authority) {
		const recordId = handle.acpxRecordId ?? handle.sessionKey;
		await this.withManagerLock(this.runtimeOperationLocks, recordId, async () => this.setModeWithOwnership(handle, mode, sessionMode, authority), authority);
	}
	async setModeWithOwnership(handle, mode, sessionMode, authority) {
		const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
		assertControlAuthority(authority);
		const controller = this.activeControllers.get(record.acpxRecordId);
		if (controller) {
			await controller.setSessionMode(mode, authority);
			return;
		}
		await this.withRuntimeControlSession(record, sessionMode, async ({ client, sessionId, record: connectedRecord }) => {
			await client.setSessionMode(sessionId, mode, authority);
			setDesiredModeId(connectedRecord, mode);
		}, { replacingMode: true }, authority);
	}
	async setModel(handle, model, sessionMode = "persistent", authority) {
		const recordId = handle.acpxRecordId ?? handle.sessionKey;
		await this.withManagerLock(this.runtimeOperationLocks, recordId, async () => this.setModelWithOwnership(handle, model, sessionMode, authority), authority);
	}
	async setModelWithOwnership(handle, model, sessionMode, authority) {
		const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
		assertControlAuthority(authority);
		const controller = this.activeControllers.get(record.acpxRecordId);
		if (controller) {
			await controller.setSessionModel(model, authority);
			return;
		}
		await this.withRuntimeControlSession(record, sessionMode, async ({ client, sessionId, record: connectedRecord }) => {
			const models = advertisedModelState(connectedRecord.acpx);
			const resolvedModelId = resolveRequestedModelId({
				requestedModel: model,
				models,
				agentCommand: connectedRecord.agentCommand
			});
			const response = await client.setSessionModel(sessionId, model, models, authority);
			connectedRecord.acpx = applyModelSelection(connectedRecord.acpx, model, response, resolvedModelId);
		}, { replacingConfigOption: { key: "model" } }, authority);
	}
	async setConfigOption(handle, key, value, sessionMode = "persistent", authority) {
		const recordId = handle.acpxRecordId ?? handle.sessionKey;
		return await this.withManagerLock(this.runtimeOperationLocks, recordId, async () => this.setConfigOptionWithOwnership(handle, key, value, sessionMode, authority), authority);
	}
	async setConfigOptionWithOwnership(handle, key, value, sessionMode, authority) {
		const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
		assertControlAuthority(authority);
		const controller = this.activeControllers.get(record.acpxRecordId);
		if (controller) {
			const { response } = await controller.setResolvedSessionConfigOption(key, value, authority);
			return response;
		}
		return await this.withRuntimeControlSession(record, sessionMode, async ({ client, sessionId, record: connectedRecord }) => {
			const configId = resolveSupportedConfigOptionId(connectedRecord, key);
			const models = advertisedModelState(connectedRecord.acpx);
			const { modelConfigId, resolvedValue } = resolveRequestedConfigOption({
				configId,
				value,
				models,
				agentCommand: connectedRecord.agentCommand
			});
			const response = await client.setSessionConfigOption(sessionId, configId, value, models, authority);
			connectedRecord.acpx = applyConfigOptionSelection(connectedRecord.acpx, configId, value, response, modelConfigId, resolvedValue);
			return response;
		}, { replacingConfigOption: {
			key,
			resolve: (connectedRecord) => resolveSupportedConfigOptionId(connectedRecord, key)
		} }, authority);
	}
	async cancel(handle) {
		await this.activeControllers.get(handle.acpxRecordId ?? handle.sessionKey)?.requestCancelActivePrompt();
	}
	prepareFreshSession(handle) {
		this.assertOpen();
		const recordId = handle.acpxRecordId ?? handle.sessionKey;
		const cancelled = this.cancelSessionTasks(recordId);
		cancelled.catch(() => {});
		return this.queueSessionTask(recordId, async () => {
			const tasks = await cancelled;
			await Promise.all(tasks.map((task) => task.completion));
			return await this.withManagerLock(this.runtimeOperationLocks, recordId, async () => this.closeRuntimeSession(handle, "prepare-fresh"));
		});
	}
	close(handle, options = {}) {
		this.assertOpen();
		const recordId = handle.acpxRecordId ?? handle.sessionKey;
		return this.trackTask(this.withManagerLock(this.runtimeOperationLocks, recordId, async () => {
			return await this.closeRuntimeSession(handle, options.discardPersistentState === true ? "discard" : "release");
		}));
	}
	async closeRuntimeSession(handle, intent) {
		const recordId = handle.acpxRecordId ?? handle.sessionKey;
		await this.retrySessionCleanup(recordId);
		const record = await this.resolveRuntimeRecordForClose(recordId);
		this.markActiveRuntimeRecordClosing(record);
		if (intent !== "prepare-fresh") await this.cancelSessionTasks(recordId);
		const closeFailure = await this.closeRuntimeRecordOwnership(record, intent);
		if (intent === "discard") {
			if (closeFailure) throw closeFailure.error;
			return;
		}
		const saveAttempt = await settleAttempt(async () => this.saveClosedRuntimeRecord(record, intent !== "release"));
		const failure = closeFailure ?? firstFailedAttempt([saveAttempt]);
		if (failure) throw failure.error;
	}
	async saveClosedRuntimeRecord(record, reset) {
		record.closed = true;
		record.closedAt = isoNow();
		if (reset) record.acpx = {
			...record.acpx,
			reset_on_next_ensure: true
		};
		await this.options.sessionStore.save(record);
	}
	async resolveRuntimeRecordForClose(recordId) {
		const retainedOwner = this.retainedSessionOwners.get(recordId);
		if (retainedOwner) await this.flushSessionOwner(retainedOwner);
		return retainedOwner?.projection?.record ?? await this.requireRecord(recordId);
	}
	markActiveRuntimeRecordClosing(record) {
		if (this.activeControllers.has(record.acpxRecordId)) this.closingActiveRecords.add(record.acpxRecordId);
	}
	async closeRuntimeRecordOwnership(record, intent) {
		if (intent === "discard") return await this.closeBackendSession(record);
		else if (intent === "prepare-fresh") {
			const owner = this.retainedSessionOwners.get(record.acpxRecordId);
			if (owner) {
				this.removeRetainedSessionOwner(owner);
				this.retiringSessionOwners.add(owner);
			}
			await this.retrySessionCleanup(record.acpxRecordId);
		} else await this.closeRetainedSessionOwner(record.acpxRecordId);
	}
	async closeBackendSession(record) {
		const connection = await this.acquireBackendCloseConnection(record);
		const requestAttempt = await settleAttempt(async () => {
			try {
				await this.requestBackendSessionClose(record, connection);
			} catch (error) {
				this.handleBackendSessionCloseError(record, error);
			}
		});
		const owner = connection.owner ?? this.createSessionOwner({
			client: connection.client,
			sessionKey: record.acpxRecordId,
			mode: "persistent"
		});
		owner.recordId = record.acpxRecordId;
		const finalizeAttempt = await settleAttempt(async () => this.finalizeSessionConnection(connection));
		owner.pendingResetRecord = record;
		this.retiringSessionOwners.add(owner);
		if (!finalizeAttempt.ok) throw finalizeAttempt.error;
		const saveAttempt = await settleAttempt(async () => this.settleRetiredSessionRecord(owner));
		if (saveAttempt.ok) this.retiringSessionOwners.delete(owner);
		return firstFailedAttempt([requestAttempt, saveAttempt]);
	}
	async finalizeSessionConnection(connection) {
		const failure = firstFailedAttempt([
			await settleAttempt(async () => {
				if (connection.owner) await this.flushSessionOwner(connection.owner);
			}),
			await settleAttempt(() => connection.owner?.client.clearEventHandlers()),
			await settleAttempt(async () => this.closeClient(connection.client)),
			await settleAttempt(async () => connection.owner?.checkpoint.flush())
		]);
		if (failure) throw failure.error;
	}
	async acquireBackendCloseConnection(record) {
		const owner = await this.readRetainedSessionOwner(record, { consume: true });
		if (owner) return {
			client: owner.client,
			owner
		};
		return { client: this.createTurnClient(record) };
	}
	async requestBackendSessionClose(record, connection) {
		if (!connection.owner) await withTimeout(connection.client.start(), this.options.timeoutMs);
		if (!connection.client.supportsCloseSession()) throw new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", `Agent does not support session/close for ${record.acpxRecordId}.`);
		await withTimeout(connection.client.closeSession(record.acpSessionId), this.options.timeoutMs);
	}
	handleBackendSessionCloseError(record, error) {
		if (isAcpResourceNotFoundError(error)) return;
		if (isUnsupportedSessionCloseError(error)) throw new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", `Agent does not support session/close for ${record.acpxRecordId}.`, { cause: error });
		throw error;
	}
	async requireRecord(sessionId) {
		const record = await this.options.sessionStore.load(sessionId);
		if (!record) throw new Error(`ACP session not found: ${sessionId}`);
		return record;
	}
};
// src/runtime/public/file-session-store.ts
function safeSessionId(sessionId) {
	return encodeURIComponent(sessionId);
}
var FileSessionStore = class {
	stateDir;
	constructor(stateDir) {
		this.stateDir = stateDir;
	}
	get sessionDir() {
		return path.join(this.stateDir, "sessions");
	}
	filePath(sessionId) {
		return path.join(this.sessionDir, `${safeSessionId(sessionId)}.json`);
	}
	async ensureDir() {
		await fs.mkdir(this.sessionDir, {
			recursive: true,
			mode: 448
		});
	}
	async load(sessionId) {
		await this.ensureDir();
		let payload;
		try {
			payload = await fs.readFile(this.filePath(sessionId), "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
		let parsed;
		try {
			parsed = JSON.parse(payload);
		} catch {
			return;
		}
		const record = parseSessionRecord(parsed);
		return record?.acpxRecordId === sessionId ? record : void 0;
	}
	async save(record) {
		const persisted = serializeSessionRecordForDisk(record);
		assertPersistedKeyPolicy(persisted);
		await writePrivateJsonFile(this.filePath(record.acpxRecordId), persisted);
	}
};
function createFileSessionStore(options) {
	return new FileSessionStore(path.resolve(options.stateDir));
}
// src/runtime/public/handle-state.ts
const ACPX_RUNTIME_HANDLE_PREFIX = "acpx:v2:";
function encodeAcpxRuntimeHandleState(state) {
	const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
	return `${ACPX_RUNTIME_HANDLE_PREFIX}${payload}`;
}
function decodeAcpxRuntimeHandleState(runtimeSessionName) {
	const trimmed = runtimeSessionName.trim();
	if (!trimmed.startsWith(ACPX_RUNTIME_HANDLE_PREFIX)) return null;
	try {
		const raw = Buffer.from(trimmed.slice(8), "base64url").toString("utf8");
		const parsed = JSON.parse(raw);
		const name = asOptionalString(parsed.name);
		const agent = asOptionalString(parsed.agent);
		const cwd = asOptionalString(parsed.cwd);
		const mode = asOptionalString(parsed.mode);
		if (!name || !agent || !cwd || mode !== "persistent" && mode !== "oneshot") return null;
		return {
			name,
			agent,
			cwd,
			mode,
			acpxRecordId: asOptionalString(parsed.acpxRecordId),
			backendSessionId: asOptionalString(parsed.backendSessionId),
			agentSessionId: asOptionalString(parsed.agentSessionId)
		};
	} catch {
		return null;
	}
}
function writeHandleState(handle, state) {
	handle.runtimeSessionName = encodeAcpxRuntimeHandleState(state);
	handle.cwd = state.cwd;
	handle.acpxRecordId = state.acpxRecordId;
	handle.backendSessionId = state.backendSessionId;
	handle.agentSessionId = state.agentSessionId;
}
// src/runtime/shared.ts
const SHARED_BACKEND = "acpx-shared";
function invalidOption(message) {
	throw new AcpRuntimeError("ACP_INVALID_RUNTIME_OPTION", message);
}
function sharedHandle(record) {
	return {
		backend: SHARED_BACKEND,
		sessionKey: record.name ?? "",
		runtimeSessionName: record.acpxRecordId,
		acpxRecordId: record.acpxRecordId,
		backendSessionId: record.acpSessionId,
		agentSessionId: record.agentSessionId,
		cwd: record.cwd
	};
}
function sharedRecordId(handle) {
	if (handle.backend !== SHARED_BACKEND || !handle.acpxRecordId) return invalidOption("A shared runtime requires a handle from a shared session.");
	return handle.acpxRecordId;
}
/**
* Shared controls are owner-only. Falling back to a direct connection would
* start a second adapter connection for a session another process owns, and
* that path may create a fresh provider session when the saved one no longer
* loads. Shared turns already refuse that trade; controls refuse it too.
*/
function requireOwnerDispatch(result, control) {
	if (result === void 0) throw new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", `No running owner holds this shared session, so ${control} was not sent. Submit a turn to start an owner, or apply the change with the equivalent acpx command, which connects directly instead of starting one.`);
	return result;
}
function turnFailure(error) {
	const normalized = normalizeOutputError(error, {
		defaultCode: "RUNTIME",
		origin: "queue"
	});
	if (normalized.detailCode === "QUEUE_REQUEST_CANCELLED") return {
		status: "cancelled",
		stopReason: "cancelled"
	};
	return {
		status: "failed",
		error: {
			message: normalized.message,
			code: normalized.code,
			detailCode: normalized.detailCode,
			retryable: normalized.retryable
		}
	};
}
/** A client of the CLI's local session owner. Shutdown detaches this client. */
var SharedAcpRuntime = class {
	registry;
	options;
	disconnect = new AbortController();
	pending = /* @__PURE__ */ new Set();
	controlChains = /* @__PURE__ */ new Map();
	constructor(options) {
		for (const name of [
			"sessionStore",
			"agentProcessEnv",
			"agentProcessEnvAllow",
			"agentProcessEnvBlock",
			"mcpServers",
			"sessionPermissions",
			"processLifecycle",
			"onPermissionRequest",
			"elicitationModes",
			"fs",
			"terminal"
		]) if (Object.hasOwn(options, name)) invalidOption(`${name} belongs to the in-process runtime and is not supported by shared sessions.`);
		this.options = {
			...options,
			cwd: path.resolve(options.cwd),
			authCredentials: options.authCredentials ? { ...options.authCredentials } : void 0
		};
		this.registry = options.agentRegistry ?? createAgentRegistry();
	}
	assertOpen() {
		if (this.disconnect.signal.aborted) throw new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "Shared ACP runtime is shut down.");
	}
	track(task) {
		this.pending.add(task);
		task.then(() => this.pending.delete(task), () => this.pending.delete(task));
		return task;
	}
	sessionOptions(input) {
		if (!input.agent.trim()) invalidOption("ACP agent id is required.");
		return {
			...normalizeAgentCommandInput(this.registry.resolve(input.agent)),
			cwd: path.resolve(input.cwd ?? this.options.cwd),
			name: input.sessionKey.trim() || void 0
		};
	}
	async findSession(input) {
		this.assertOpen();
		const record = await findSession(this.sessionOptions(input));
		return record ? sharedHandle(record) : void 0;
	}
	ensureSession(input) {
		this.assertOpen();
		if (input.mode !== "persistent") invalidOption("Shared sessions require persistent mode; use the in-process runtime for oneshot sessions.");
		const session = this.sessionOptions(input);
		return this.track(ensureSession({
			...this.options,
			...session,
			walkBoundary: session.cwd,
			sessionOptions: input.sessionOptions,
			resumeSessionId: input.resumeSessionId,
			handleProcessInterrupts: false,
			signal: this.disconnect.signal
		}).then(({ record }) => {
			this.assertOpen();
			return sharedHandle(record);
		}));
	}
	startTurn(input) {
		this.assertOpen();
		if (input.mode !== "prompt" || input.assertActive || input.onPermissionRequest || input.onElicitation) invalidOption("Shared turns support prompt mode and the client's static permission policy; in-process callbacks and steering are unsupported.");
		if (!input.requestId.trim()) invalidOption("A shared turn requires a requestId.");
		const sessionId = sharedRecordId(input.handle);
		const prompt = toPromptInput(input.text, input.attachments);
		const events = new AsyncEventQueue();
		const promptStarted = createDeferred();
		promptStarted.promise.catch(() => {});
		let accepted = false;
		let settled = false;
		let cancelRequested = input.signal?.aborted === true;
		let cancellation;
		const cancel = async () => {
			cancelRequested = true;
			if (!accepted || settled) return;
			cancellation ??= tryCancelOnRunningOwner({
				sessionId,
				targetRequestId: input.requestId
			}).then(() => {});
			await cancellation;
		};
		const onAbort = () => {
			cancel().catch(() => {});
		};
		input.signal?.addEventListener("abort", onAbort, { once: true });
		const run = async () => {
			if (cancelRequested) return {
				status: "cancelled",
				stopReason: "cancelled"
			};
			if ((await resolveSessionRecord(sessionId)).closed) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "Shared session is closed; ensure it again before submitting a turn.");
			if (cancelRequested) return {
				status: "cancelled",
				stopReason: "cancelled"
			};
			const result = await sendSession({
				...this.options,
				sessionId,
				requestId: input.requestId,
				prompt: typeof prompt === "string" ? textPrompt(prompt) : prompt,
				resumePolicy: "same-session-only",
				requireSharedRuntime: true,
				signal: this.disconnect.signal,
				timeoutMs: input.timeoutMs ?? this.options.timeoutMs,
				queueOwnerArgs: [fileURLToPath(import.meta.resolve("acpx/dist/cli.js")), "__queue-owner"],
				onQueueAccepted: () => {
					accepted = true;
					if (cancelRequested) cancel().catch(() => {});
				},
				onPromptStarted: () => promptStarted.resolve(),
				outputFormatter: {
					...DISCARD_OUTPUT_FORMATTER,
					onAcpMessage: (message) => {
						const event = parsePromptEventLine(JSON.stringify(message));
						if (event) events.push(event);
					}
				},
				errorEmissionPolicy: { queueErrorAlreadyEmitted: false },
				waitForCompletion: true
			});
			if ("queued" in result) throw new AcpRuntimeError("ACP_TURN_FAILED", "Shared turn ended without a completion result.");
			return {
				status: result.stopReason === "cancelled" ? "cancelled" : "completed",
				stopReason: result.stopReason,
				_meta: result._meta
			};
		};
		const result = this.track(run().catch(turnFailure).finally(() => {
			settled = true;
			promptStarted.reject(new AcpRuntimeError("ACP_TURN_FAILED", "Turn settled before its prompt was written."));
			input.signal?.removeEventListener("abort", onAbort);
			events.close();
		}));
		return {
			requestId: input.requestId,
			promptStarted: promptStarted.promise,
			events: events.iterate(),
			result,
			cancel,
			closeStream: async () => {
				events.clear();
				events.close();
			}
		};
	}
	async *runTurn(input) {
		const turn = this.startTurn(input);
		yield* turn.events;
		yield legacyTerminalEventFromTurnResult(await turn.result);
	}
	async getStatus(input) {
		this.assertOpen();
		return runtimeStatusFromRecord(await resolveSessionRecord(sharedRecordId(input.handle)));
	}
	async getCapabilities(input) {
		this.assertOpen();
		if (!input?.handle) return capabilitiesFromRecord(void 0);
		return capabilitiesFromRecord(await readSessionRecord(sharedRecordId(input.handle)));
	}
	/**
	* Preserves this client's control order, including caller-side persistence
	* when talking to older owners. Updated owners checkpoint accepted controls
	* themselves; serialization here cannot coordinate other legacy callers.
	*/
	chainControl(sessionId, run) {
		const result = (this.controlChains.get(sessionId) ?? Promise.resolve()).then(run, run);
		const chained = result.then(() => void 0, () => void 0);
		this.controlChains.set(sessionId, chained);
		chained.then(() => {
			if (this.controlChains.get(sessionId) === chained) this.controlChains.delete(sessionId);
		});
		return result;
	}
	/**
	* Checks this client's authority locally, then hands the control to the
	* running owner. The check gates this client's dispatch only; it cannot gate
	* controls other clients of the same owner send, and it cannot recall a
	* control the owner already accepted.
	*/
	async dispatchControl(input, control, send) {
		this.assertOpen();
		const sessionId = sharedRecordId(input.handle);
		const assertAuthority = () => {
			this.assertOpen();
			assertControlAuthority(input);
		};
		return await this.track(this.chainControl(sessionId, async () => {
			assertAuthority();
			return requireOwnerDispatch(await send(sessionId, assertAuthority), control);
		}));
	}
	async setMode(input) {
		await this.dispatchControl(input, "session/set_mode", async (sessionId, assertAuthority) => setSessionModeOnOwner({
			sessionId,
			modeId: input.mode,
			timeoutMs: this.options.timeoutMs,
			assertDispatch: assertAuthority
		}));
	}
	async setModel(input) {
		await this.dispatchControl(input, "session/set_model", async (sessionId, assertAuthority) => setSessionModelOnOwner({
			sessionId,
			modelId: input.model,
			timeoutMs: this.options.timeoutMs,
			assertDispatch: assertAuthority
		}));
	}
	async setConfigOption(input) {
		return (await this.dispatchControl(input, "session/set_config_option", async (sessionId, assertAuthority) => {
			const configId = resolveSupportedConfigOptionId(await resolveSessionRecord(sessionId), input.key);
			assertAuthority();
			return await setSessionConfigOptionOnOwner({
				sessionId,
				configId,
				value: input.value,
				timeoutMs: this.options.timeoutMs,
				assertDispatch: assertAuthority
			});
		})).response;
	}
	watchSession(input) {
		this.assertOpen();
		const signal = input.signal ? AbortSignal.any([input.signal, this.disconnect.signal]) : this.disconnect.signal;
		const recordId = sharedRecordId(input.handle);
		const record = readSessionRecord(recordId).then((value) => {
			if (!value || value.acpxRecordId !== recordId) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "Shared session record is unavailable.");
			return value;
		});
		record.catch(() => {});
		return watchSession({
			record,
			cursor: input.cursor,
			signal
		});
	}
	async cancel(input) {
		this.assertOpen();
		await this.track(cancelSessionPrompt({ sessionId: sharedRecordId(input.handle) }));
	}
	async close(input) {
		this.assertOpen();
		await this.track(closeSession(sharedRecordId(input.handle)));
	}
	async shutdown() {
		this.disconnect.abort(new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "Shared client detached; submitted work may still be running."));
		await Promise.allSettled(this.pending);
	}
};
function createSharedAcpRuntime(options) {
	return new SharedAcpRuntime(options);
}
// src/runtime.ts
const ACPX_BACKEND_ID = "acpx";
var AcpxRuntime = class {
	options;
	testOptions;
	healthy = false;
	shutdownTask;
	probeTasks = /* @__PURE__ */ new Set();
	manager = null;
	managerPromise = null;
	constructor(options, testOptions) {
		this.options = options;
		this.testOptions = testOptions;
		if (options.agentProcessEnv || options.agentProcessEnvAllow !== void 0 || options.agentProcessEnvBlock !== void 0) this.options = {
			...options,
			agentProcessEnv: options.agentProcessEnv ? { ...options.agentProcessEnv } : void 0,
			agentProcessEnvAllow: snapshotEnvNames("agentProcessEnvAllow", options.agentProcessEnvAllow),
			agentProcessEnvBlock: snapshotEnvNames("agentProcessEnvBlock", options.agentProcessEnvBlock)
		};
	}
	isHealthy() {
		return this.healthy;
	}
	async probeAvailability() {
		const report = await this.runProbe();
		this.healthy = report.ok;
	}
	async doctor() {
		const report = await this.runProbe();
		this.healthy = report.ok;
		return {
			ok: report.ok,
			code: report.ok ? void 0 : "ACP_BACKEND_UNAVAILABLE",
			message: report.message,
			details: normalizeRuntimeDetails(report.details)
		};
	}
	resolveSessionIdentity(input) {
		const sessionName = input.sessionKey.trim();
		if (!sessionName) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
		const agent = input.agent.trim();
		if (!agent) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP agent id is required.");
		return {
			sessionName,
			agent
		};
	}
	async findSession(input) {
		const { sessionName, agent } = this.resolveSessionIdentity(input);
		const record = await (await this.getManager()).findSession(sessionName);
		return record ? this.createSessionHandle({
			sessionKey: input.sessionKey,
			agent,
			mode: "persistent"
		}, record) : void 0;
	}
	async ensureSession(input) {
		const { sessionName, agent } = this.resolveSessionIdentity(input);
		const record = await (await this.getManager()).ensureSession({
			sessionKey: sessionName,
			agent,
			mode: input.mode,
			cwd: input.cwd ?? this.options.cwd,
			resumeSessionId: input.resumeSessionId,
			sessionOptions: input.sessionOptions
		});
		return this.createSessionHandle({
			...input,
			agent
		}, record);
	}
	createSessionHandle(input, record) {
		const handle = {
			sessionKey: input.sessionKey,
			backend: ACPX_BACKEND_ID,
			runtimeSessionName: "",
			cwd: record.cwd,
			acpxRecordId: record.acpxRecordId,
			backendSessionId: record.acpSessionId,
			agentSessionId: record.agentSessionId
		};
		writeHandleState(handle, {
			name: input.sessionKey.trim(),
			agent: input.agent,
			cwd: record.cwd,
			mode: input.mode,
			acpxRecordId: record.acpxRecordId,
			backendSessionId: record.acpSessionId,
			agentSessionId: record.agentSessionId
		});
		return handle;
	}
	startTurn(input) {
		const { handle, state } = this.resolveManagerHandle(input.handle);
		const turnPromise = this.getManager().then((manager) => manager.startTurn({
			handle,
			text: input.text,
			attachments: input.attachments,
			mode: input.mode,
			sessionMode: state.mode,
			requestId: input.requestId,
			timeoutMs: input.timeoutMs,
			signal: input.signal,
			assertActive: input.assertActive,
			onElicitation: input.onElicitation,
			onPermissionRequest: input.onPermissionRequest
		}));
		turnPromise.catch(() => {});
		return {
			requestId: input.requestId,
			get promptStarted() {
				return turnPromise.then((turn) => turn.promptStarted);
			},
			events: { async *[Symbol.asyncIterator]() {
				yield* (await turnPromise).events;
			} },
			get result() {
				return turnPromise.then((turn) => turn.result);
			},
			cancel(inputArgs) {
				return turnPromise.then((turn) => turn.cancel(inputArgs));
			},
			closeStream(inputArgs) {
				return turnPromise.then((turn) => turn.closeStream(inputArgs));
			}
		};
	}
	async *runTurn(input) {
		const { handle, state } = this.resolveManagerHandle(input.handle);
		yield* (await this.getManager()).runTurn({
			handle,
			text: input.text,
			attachments: input.attachments,
			mode: input.mode,
			sessionMode: state.mode,
			requestId: input.requestId,
			timeoutMs: input.timeoutMs,
			signal: input.signal,
			assertActive: input.assertActive,
			onElicitation: input.onElicitation,
			onPermissionRequest: input.onPermissionRequest
		});
	}
	async getCapabilities(input) {
		if (!input?.handle) return capabilitiesFromRecord(void 0);
		const { handle } = this.resolveManagerHandle(input.handle);
		return capabilitiesFromRecord(await this.options.sessionStore.load(handle.acpxRecordId ?? handle.sessionKey));
	}
	async getStatus(input) {
		const { handle } = this.resolveManagerHandle(input.handle);
		return await (await this.getManager()).getStatus(handle);
	}
	async setMode(input) {
		const { handle, state } = this.resolveManagerHandle(input.handle);
		await (await this.getManager()).setMode(handle, input.mode, state.mode, input);
	}
	async setModel(input) {
		const { handle, state } = this.resolveManagerHandle(input.handle);
		await (await this.getManager()).setModel(handle, input.model, state.mode, input);
	}
	async setConfigOption(input) {
		const { handle, state } = this.resolveManagerHandle(input.handle);
		return await (await this.getManager()).setConfigOption(handle, input.key, input.value, state.mode, input);
	}
	async cancel(input) {
		const { handle } = this.resolveManagerHandle(input.handle);
		await (await this.getManager()).cancel(handle);
	}
	async prepareFreshSession(input) {
		const { handle } = this.resolveManagerHandle(input.handle);
		await (await this.getManager()).prepareFreshSession(handle);
	}
	async close(input) {
		const { handle } = this.resolveManagerHandle(input.handle);
		await (await this.getManager()).close(handle, { discardPersistentState: input.discardPersistentState });
	}
	shutdown() {
		if (!this.shutdownTask) {
			this.healthy = false;
			const managerShutdown = this.managerPromise?.then((manager) => manager.shutdown());
			this.shutdownTask = Promise.allSettled([managerShutdown, ...this.probeTasks]).then(([manager]) => {
				if (manager.status === "rejected") throw manager.reason;
			});
		}
		return this.shutdownTask;
	}
	async getManager() {
		if (this.shutdownTask) throw new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "ACP runtime is shut down.");
		if (this.manager) return this.manager;
		if (!this.managerPromise) this.managerPromise = Promise.resolve(this.testOptions?.managerFactory?.(this.options) ?? new AcpRuntimeManager(this.options)).then((manager) => {
			this.manager = manager;
			return manager;
		});
		return await this.managerPromise;
	}
	async runProbe() {
		if (this.shutdownTask) throw new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "ACP runtime is shut down.");
		const probe = this.testOptions?.probeRunner?.(this.options) ?? this.getManager().then((manager) => manager.probe());
		this.probeTasks.add(probe);
		try {
			const report = await probe;
			if (this.shutdownTask) throw new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "ACP runtime is shut down.");
			return report;
		} finally {
			this.probeTasks.delete(probe);
		}
	}
	resolveManagerHandle(handle) {
		const state = this.resolveHandleState(handle);
		return {
			handle: {
				...handle,
				acpxRecordId: state.acpxRecordId ?? handle.acpxRecordId ?? handle.sessionKey
			},
			state
		};
	}
	resolveHandleState(handle) {
		const decoded = decodeAcpxRuntimeHandleState(handle.runtimeSessionName);
		if (decoded) return {
			...decoded,
			acpxRecordId: decoded.acpxRecordId ?? handle.acpxRecordId,
			backendSessionId: decoded.backendSessionId ?? handle.backendSessionId,
			agentSessionId: decoded.agentSessionId ?? handle.agentSessionId
		};
		const runtimeSessionName = handle.runtimeSessionName.trim();
		if (!runtimeSessionName) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "Invalid embedded ACP runtime handle: runtimeSessionName is missing.");
		return {
			name: runtimeSessionName,
			agent: deriveAgentFromSessionKey(handle.sessionKey, DEFAULT_AGENT_NAME),
			cwd: handle.cwd ?? this.options.cwd,
			mode: "persistent",
			acpxRecordId: handle.acpxRecordId,
			backendSessionId: handle.backendSessionId,
			agentSessionId: handle.agentSessionId
		};
	}
};
function createAcpRuntime(options) {
	return new AcpxRuntime(options);
}
function createRuntimeStore(options) {
	return createFileSessionStore(options);
}
export { ACPX_BACKEND_ID, AcpRuntimeError, AcpxRuntime, DEFAULT_AGENT_NAME, REQUESTED_MODEL_UNSUPPORTED_ERROR_CODE, REQUESTED_MODEL_UNSUPPORTED_REASONS, RequestedModelUnsupportedError, SharedAcpRuntime, createAcpRuntime, createAgentRegistry, createFileSessionStore, createRuntimeStore, createSharedAcpRuntime, decodeAcpxRuntimeHandleState, encodeAcpxRuntimeHandleState, inspectAgentModels, isAcpRuntimeError, isRequestedModelUnsupportedError };

//# sourceMappingURL=runtime.js.map