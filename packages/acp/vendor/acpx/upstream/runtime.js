import { A as REQUESTED_MODEL_UNSUPPORTED_ERROR_CODE, At as listBuiltInAgents, D as applyLifecycleSnapshotToRecord, E as applyConversation, F as modelStateFromConfigOptions, It as normalizeOutputError, Lt as extractAcpError, M as RequestedModelUnsupportedError, Mt as resolveAgentCommand, O as reconcileAgentSessionId, Ot as withTimeout, P as isRequestedModelUnsupportedError, Rt as isAcpResourceNotFoundError, S as advertisedModelState, T as sessionOptionsFromRecord, Z as assertPersistedKeyPolicy, _ as createSessionConversation, a as applyRequestedModelIfAdvertised, b as recordSessionUpdate, c as setCurrentModelId, d as setDesiredModelId, f as syncAdvertisedModelState, g as cloneSessionConversation, h as cloneSessionAcpxState, i as connectAndLoadSession, j as REQUESTED_MODEL_UNSUPPORTED_REASONS, k as AcpClient, kt as DEFAULT_AGENT_NAME, l as setDesiredConfigOption, m as applyConfigOptionsToState, n as runPromptTurn, o as currentModelIdFromSetModelResponse, ot as parseSessionRecord, p as applyConfigOptionsToRecord, r as withConnectedSession, s as clearDesiredConfigOption, st as serializeSessionRecordForDisk, t as LiveSessionCheckpoint, u as setDesiredModeId, ut as defaultSessionEventLog, v as recordClientOperation, w as persistSessionOptions, wt as textPrompt, x as trimConversationForRuntime, y as recordPromptSubmission } from "./live-checkpoint-ClPCSdrW.js";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
//#region src/runtime/public/errors.ts
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
//#endregion
//#region src/runtime/public/shared.ts
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
//#endregion
//#region src/runtime/public/events.ts
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
	session_info_update: sessionInfoStatusText,
	plan: planStatusText
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
function resolveTextChunk(params) {
	const contentRaw = params.payload.content;
	if (isRecord(contentRaw)) {
		const contentType = asTrimmedString(contentRaw.type);
		if (contentType && contentType !== "text") return null;
		const text = asString(contentRaw.text);
		if (text && text.length > 0) return {
			type: "text_delta",
			text,
			stream: params.stream,
			tag: params.tag
		};
	}
	const text = asString(params.payload.text);
	if (!text || text.length === 0) return null;
	return {
		type: "text_delta",
		text,
		stream: params.stream,
		tag: params.tag
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
	return `${value.slice(0, TOOL_OUTPUT_SUMMARY_MAX_CHARS - 1)}…`;
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
	plan: (payload) => statusUpdateEvent("plan", payload),
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
//#endregion
//#region src/runtime/engine/reuse-policy.ts
function shouldReuseExistingRecord(record, params) {
	if (record.acpx?.reset_on_next_ensure === true) return false;
	if (path.resolve(record.cwd) !== path.resolve(params.cwd)) return false;
	if (record.agentCommand !== params.agentCommand) return false;
	if (params.resumeSessionId && record.acpSessionId !== params.resumeSessionId) return false;
	return true;
}
//#endregion
//#region src/runtime/engine/manager.ts
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
		while (true) {
			const next = await this.next();
			if (!next) return;
			yield next;
		}
	}
};
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
function createInitialRecord(params) {
	const now = isoNow();
	return {
		schema: "acpx.session.v1",
		acpxRecordId: params.recordId,
		acpSessionId: params.sessionId,
		agentSessionId: params.agentSessionId,
		agentCommand: params.agentCommand,
		cwd: params.cwd,
		name: params.sessionName,
		createdAt: now,
		lastUsedAt: now,
		lastSeq: 0,
		eventLog: defaultSessionEventLog(params.recordId),
		closed: false,
		closedAt: void 0,
		...createSessionConversation(now),
		acpx: {}
	};
}
function createRecordId(sessionKey, mode) {
	if (mode === "persistent") return sessionKey;
	return `${sessionKey}:oneshot:${randomUUID()}`;
}
function resumePolicyForSessionMode(mode) {
	return mode === "persistent" ? "same-session-only" : "allow-new";
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
		...result.stopReason ? { stopReason: result.stopReason } : {}
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
	const available = record.acpx?.available_models;
	const currentModelId = record.acpx?.current_model_id;
	if (!available || available.length === 0) return currentModelId === void 0 ? {} : { models: {
		currentModelId,
		availableModelIds: []
	} };
	return { models: {
		...currentModelId !== void 0 ? { currentModelId } : {},
		availableModelIds: [...available]
	} };
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
	const name = trimmedField(record.name);
	if (!name) return;
	const runtimeCommand = { name };
	const description = trimmedField(record.description);
	if (description) runtimeCommand.description = description;
	if (typeof record.has_input === "boolean") runtimeCommand.hasInput = record.has_input;
	return runtimeCommand;
}
function commandRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function trimmedField(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function advertisedConfigOptionIds(record) {
	const configOptions = record.acpx?.config_options;
	if (!configOptions) return;
	return new Set(configOptions.map((option) => option.id).filter((id) => typeof id === "string" && id.trim().length > 0));
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
function applyConfigOptionResponseToTurn(turn, response) {
	if (!response?.configOptions) return;
	turn.acpxState = applyConfigOptionsToState(turn.acpxState, response.configOptions);
}
function applyDesiredConfigOptionToTurn(turn, configId, value) {
	const nextState = cloneSessionAcpxState(turn.acpxState) ?? {};
	if (configId === modelStateFromConfigOptions(nextState.config_options)?.configId) {
		nextState.session_options = {
			...nextState.session_options,
			model: value
		};
		clearDesiredConfigOption(nextState, configId);
	} else if (configId === "mode") nextState.desired_mode_id = value;
	else nextState.desired_config_options = {
		...nextState.desired_config_options,
		[configId]: value
	};
	turn.acpxState = nextState;
}
function applyDesiredConfigOptionToRecord(record, configId, value) {
	if (configId === modelStateFromConfigOptions(record.acpx?.config_options)?.configId) setDesiredModelId(record, value, configId);
	else if (configId === "mode") setDesiredModeId(record, value);
	else setDesiredConfigOption(record, configId, value);
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
	pendingPersistentClients = /* @__PURE__ */ new Map();
	closingActiveRecords = /* @__PURE__ */ new Set();
	constructor(options, deps = {}) {
		this.options = options;
		this.deps = deps;
	}
	createClient(options) {
		return this.deps.clientFactory?.(options) ?? new AcpClient(options);
	}
	async readPendingPersistentClient(record, options) {
		const pendingClient = this.pendingPersistentClients.get(record.acpxRecordId);
		if (!pendingClient) return;
		if (!pendingClient.hasReusableSession(record.acpSessionId)) {
			this.pendingPersistentClients.delete(record.acpxRecordId);
			await pendingClient.close().catch(() => {});
			return;
		}
		if (options.consume) this.pendingPersistentClients.delete(record.acpxRecordId);
		return pendingClient;
	}
	async closePendingPersistentClient(recordId) {
		const pendingClient = this.pendingPersistentClients.get(recordId);
		if (!pendingClient) return;
		this.pendingPersistentClients.delete(recordId);
		await pendingClient.close().catch(() => {});
	}
	async refreshClosedState(record) {
		if (!this.closingActiveRecords.has(record.acpxRecordId)) return record.closed === true;
		const latest = await this.options.sessionStore.load(record.acpxRecordId).catch(() => void 0);
		record.closed = true;
		record.closedAt = latest?.closedAt ?? record.closedAt ?? isoNow();
		if (latest?.acpx) record.acpx = {
			...record.acpx,
			...latest.acpx
		};
		return true;
	}
	async retainPersistentClientAfterTurn(input) {
		const { record, client } = input;
		if (!!record.acpxRecordId.includes(":oneshot:") || record.closed || !client.hasReusableSession(record.acpSessionId)) return false;
		const previousClient = this.pendingPersistentClients.get(record.acpxRecordId);
		this.pendingPersistentClients.set(record.acpxRecordId, client);
		if (previousClient && previousClient !== client) await previousClient.close().catch(() => {});
		return true;
	}
	async withRuntimeControlSession(record, sessionMode, run) {
		const pendingClient = await this.readPendingPersistentClient(record, { consume: false });
		if (pendingClient) {
			const value = await run({
				client: pendingClient,
				sessionId: record.acpSessionId,
				record
			});
			record.lastUsedAt = isoNow();
			record.closed = false;
			record.closedAt = void 0;
			record.protocolVersion = pendingClient.initializeResult?.protocolVersion;
			record.agentCapabilities = pendingClient.initializeResult?.agentCapabilities;
			applyLifecycleSnapshotToRecord(record, pendingClient.getAgentLifecycleSnapshot());
			return {
				value,
				record
			};
		}
		const result = await withConnectedSession({
			sessionRecordId: record.acpxRecordId,
			loadRecord: async (sessionRecordId) => await this.requireRecord(sessionRecordId),
			saveRecord: async (connectedRecord) => await this.options.sessionStore.save(connectedRecord),
			createClient: (options) => this.createClient(options),
			mcpServers: [...this.options.mcpServers ?? []],
			permissionMode: this.options.permissionMode,
			nonInteractivePermissions: this.options.nonInteractivePermissions,
			onPermissionRequest: this.options.onPermissionRequest,
			verbose: this.options.verbose,
			timeoutMs: this.options.timeoutMs,
			resumePolicy: resumePolicyForSessionMode(sessionMode),
			run
		});
		return {
			value: result.value,
			record: result.record
		};
	}
	async ensureSession(input) {
		const cwd = path.resolve(input.cwd?.trim() || this.options.cwd);
		const agentCommand = this.options.agentRegistry.resolve(input.agent);
		const existing = await this.options.sessionStore.load(input.sessionKey);
		if (input.mode === "persistent" && existing && shouldReuseExistingRecord(existing, {
			cwd,
			agentCommand,
			resumeSessionId: input.resumeSessionId
		})) {
			existing.closed = false;
			existing.closedAt = void 0;
			this.closingActiveRecords.delete(existing.acpxRecordId);
			await this.options.sessionStore.save(existing);
			return existing;
		}
		const client = this.createClient({
			agentCommand,
			cwd,
			mcpServers: [...this.options.mcpServers ?? []],
			permissionMode: this.options.permissionMode,
			nonInteractivePermissions: this.options.nonInteractivePermissions,
			onPermissionRequest: this.options.onPermissionRequest,
			verbose: this.options.verbose,
			sessionOptions: input.sessionOptions
		});
		let keepClientOpen = false;
		try {
			await client.start();
			const session = await createOrLoadRuntimeSession(client, input.resumeSessionId, cwd);
			const record = await this.createAndSaveRuntimeRecord({
				input,
				client,
				agentCommand,
				cwd,
				session
			});
			keepClientOpen = await this.keepPersistentClient(input.mode, record.acpxRecordId, client);
			return record;
		} finally {
			if (!keepClientOpen) await client.close();
		}
	}
	async createAndSaveRuntimeRecord(params) {
		const { input, client, agentCommand, cwd, session } = params;
		const record = createInitialRecord({
			recordId: createRecordId(input.sessionKey, input.mode),
			sessionName: input.sessionKey,
			sessionId: session.sessionId,
			agentCommand,
			cwd,
			agentSessionId: session.agentSessionId
		});
		this.closingActiveRecords.delete(record.acpxRecordId);
		record.protocolVersion = client.initializeResult?.protocolVersion;
		record.agentCapabilities = client.initializeResult?.agentCapabilities;
		applyConfigOptionsToRecord(record, session.sessionResult);
		const modelApplication = await applyRequestedModelIfAdvertised({
			client,
			sessionId: session.sessionId,
			requestedModel: input.sessionOptions?.model,
			models: session.sessionResult.models,
			agentCommand,
			timeoutMs: this.options.timeoutMs
		});
		applyConfigOptionsToRecord(record, modelApplication.response);
		syncAdvertisedModelState(record, modelApplication.response ? modelStateFromConfigOptions(modelApplication.response.configOptions) : session.sessionResult.models);
		if (modelApplication.applied) setCurrentModelId(record, currentModelIdFromSetModelResponse(modelApplication.response, input.sessionOptions?.model));
		applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
		persistSessionOptions(record, input.sessionOptions);
		await this.options.sessionStore.save(record);
		return record;
	}
	async keepPersistentClient(mode, recordId, client) {
		if (mode !== "persistent") return false;
		const previousClient = this.pendingPersistentClients.get(recordId);
		this.pendingPersistentClients.set(recordId, client);
		await previousClient?.close().catch(() => {});
		return true;
	}
	startTurn(input) {
		const promptInput = toPromptInput(input.text, input.attachments);
		const queue = new AsyncEventQueue();
		const result = createDeferred();
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
			requestCancel();
		};
		if (input.signal) {
			if (input.signal.aborted) {
				closeStream();
				settleResult({
					status: "cancelled",
					stopReason: "cancelled"
				});
				return {
					requestId: input.requestId,
					events: queue.iterate(),
					result: result.promise,
					cancel: async () => {},
					closeStream: async () => {}
				};
			}
			input.signal.addEventListener("abort", abortHandler, { once: true });
		}
		this.runRuntimeTurnTask({
			input,
			promptInput,
			queue,
			sessionReady,
			state,
			settleResult,
			abortHandler
		});
		return {
			requestId: input.requestId,
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
	async runRuntimeTurnTask(task) {
		let turn;
		try {
			turn = await this.prepareRuntimeTurn(task);
			const { sessionId, resumed, loadError } = await this.connectRuntimeTurn(task, turn);
			await this.resolveRuntimeTurnReady(task, turn, resumed, loadError);
			if (this.cancelRuntimeTurnBeforePrompt(task)) return;
			await this.applyPendingRuntimeTurnCancel(task, turn);
			const response = await runPromptTurn({
				client: turn.client,
				sessionId,
				prompt: task.promptInput,
				timeoutMs: task.input.timeoutMs ?? this.options.timeoutMs,
				conversation: turn.conversation,
				promptMessageId: turn.promptMessageId
			});
			await this.saveCompletedRuntimeTurn(turn, response.stopReason);
			task.settleResult({
				status: response.stopReason === "cancelled" ? "cancelled" : "completed",
				...response.stopReason ? { stopReason: response.stopReason } : {}
			});
		} catch (error) {
			this.failRuntimeTurn(task, error);
		} finally {
			await this.finalizeRuntimeTurn(task, turn);
		}
	}
	async prepareRuntimeTurn(task) {
		const record = await this.requireRecord(task.input.handle.acpxRecordId ?? task.input.handle.sessionKey);
		const conversation = cloneSessionConversation(record);
		let acpxState = cloneSessionAcpxState(record.acpx);
		const promptStartedAt = isoNow();
		const promptMessageId = recordPromptSubmission(conversation, task.promptInput, promptStartedAt);
		trimConversationForRuntime(conversation);
		record.lastPromptAt = promptStartedAt;
		record.lastUsedAt = promptStartedAt;
		record.acpx = acpxState;
		applyConversation(record, conversation);
		await this.options.sessionStore.save(record);
		const pendingClient = await this.readPendingPersistentClient(record, { consume: true });
		const client = pendingClient ?? this.createTurnClient(record);
		const turn = {
			record,
			conversation,
			acpxState,
			liveCheckpoint: this.createRuntimeTurnCheckpoint(record, conversation, () => turn.acpxState),
			client,
			pendingClient,
			promptMessageId,
			activeSessionId: record.acpSessionId
		};
		task.state.activeController = this.buildRuntimeTurnController(task, turn);
		this.activeControllers.set(record.acpxRecordId, task.state.activeController);
		this.installRuntimeTurnEventHandlers(task, turn);
		return turn;
	}
	createTurnClient(record) {
		return this.createClient({
			agentCommand: record.agentCommand,
			cwd: record.cwd,
			mcpServers: [...this.options.mcpServers ?? []],
			permissionMode: this.options.permissionMode,
			nonInteractivePermissions: this.options.nonInteractivePermissions,
			onPermissionRequest: this.options.onPermissionRequest,
			verbose: this.options.verbose,
			sessionOptions: sessionOptionsFromRecord(record)
		});
	}
	createRuntimeTurnCheckpoint(record, conversation, readAcpxState) {
		return new LiveSessionCheckpoint({ save: async () => {
			record.lastUsedAt = isoNow();
			record.acpx = readAcpxState();
			applyConversation(record, conversation);
			await this.refreshClosedState(record);
			await this.options.sessionStore.save(record);
		} });
	}
	buildRuntimeTurnController(task, turn) {
		return {
			hasActivePrompt: () => turn.client.hasActivePrompt(),
			requestCancelActivePrompt: async () => await this.requestRuntimeTurnCancel(task, turn),
			setSessionMode: async (modeId) => {
				await this.waitForRuntimeControlSession(task, turn);
				await turn.client.setSessionMode(turn.activeSessionId, modeId);
				const nextState = cloneSessionAcpxState(turn.acpxState) ?? {};
				nextState.desired_mode_id = modeId;
				turn.acpxState = nextState;
			},
			setSessionModel: async (modelId) => {
				await this.waitForRuntimeControlSession(task, turn);
				const models = advertisedModelState(turn.acpxState);
				const response = await turn.client.setSessionModel(turn.activeSessionId, modelId, models);
				applyConfigOptionResponseToTurn(turn, response);
				const nextState = cloneSessionAcpxState(turn.acpxState) ?? {};
				nextState.session_options = {
					...nextState.session_options,
					model: modelId
				};
				nextState.current_model_id = currentModelIdFromSetModelResponse(response, modelId);
				clearDesiredConfigOption(nextState, models?.configId);
				turn.acpxState = nextState;
				return response;
			},
			setSessionConfigOption: async (configId, value) => {
				return (await task.state.activeController.setResolvedSessionConfigOption(configId, value)).response;
			},
			setResolvedSessionConfigOption: async (configId, value) => await this.setRuntimeResolvedSessionConfigOption(task, turn, configId, value)
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
	async setRuntimeResolvedSessionConfigOption(task, turn, configId, value) {
		await this.waitForRuntimeControlSession(task, turn);
		const resolvedConfigId = resolveSupportedConfigOptionId({
			...turn.record,
			acpx: turn.acpxState ?? void 0
		}, configId);
		const response = await turn.client.setSessionConfigOption(turn.activeSessionId, resolvedConfigId, value);
		this.applyRuntimeConfigOptionState(turn, resolvedConfigId, value, response);
		return {
			configId: resolvedConfigId,
			response
		};
	}
	applyRuntimeConfigOptionState(turn, configId, value, response) {
		applyConfigOptionResponseToTurn(turn, response);
		applyDesiredConfigOptionToTurn(turn, configId, value);
	}
	installRuntimeTurnEventHandlers(task, turn) {
		turn.client.setEventHandlers({
			onSessionUpdate: (notification) => {
				turn.acpxState = recordSessionUpdate(turn.conversation, turn.acpxState, notification);
				trimConversationForRuntime(turn.conversation);
				turn.liveCheckpoint.request();
				this.emitRuntimeTurnEvent(task, {
					jsonrpc: "2.0",
					method: "session/update",
					params: notification
				});
			},
			onClientOperation: (operation) => {
				turn.acpxState = recordClientOperation(turn.conversation, turn.acpxState, operation);
				trimConversationForRuntime(turn.conversation);
				turn.liveCheckpoint.request();
				this.emitRuntimeTurnEvent(task, {
					type: "client_operation",
					...operation
				});
			}
		});
	}
	emitRuntimeTurnEvent(task, payload) {
		const parsed = parsePromptEventLine(JSON.stringify(payload));
		if (!parsed) return;
		task.queue.push(parsed);
	}
	async connectRuntimeTurn(task, turn) {
		const loaded = turn.pendingClient ? {
			sessionId: turn.record.acpSessionId,
			resumed: false,
			loadError: void 0
		} : await this.connectRuntimeTurnClient(task, turn);
		turn.acpxState = cloneSessionAcpxState(turn.record.acpx);
		return loaded;
	}
	async connectRuntimeTurnClient(task, turn) {
		return await connectAndLoadSession({
			client: turn.client,
			record: turn.record,
			resumePolicy: resumePolicyForSessionMode(task.input.sessionMode),
			timeoutMs: this.options.timeoutMs,
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
	async resolveRuntimeTurnReady(task, turn, resumed, loadError) {
		task.sessionReady.resolve();
		turn.record.lastRequestId = task.input.requestId;
		turn.record.lastPromptAt = isoNow();
		turn.record.closed = false;
		turn.record.closedAt = void 0;
		turn.record.lastUsedAt = isoNow();
		await turn.liveCheckpoint.checkpoint();
		this.emitRuntimeTurnLoadStatus(task, resumed, loadError);
	}
	emitRuntimeTurnLoadStatus(task, resumed, loadError) {
		if (!resumed && !loadError) return;
		this.emitRuntimeTurnEvent(task, {
			type: "status",
			text: loadError ? `session reconnect fallback: ${loadError}` : "session resumed"
		});
	}
	cancelRuntimeTurnBeforePrompt(task) {
		if (!task.state.pendingCancel && !task.input.signal?.aborted) return false;
		task.state.pendingCancel = false;
		task.settleResult({
			status: "cancelled",
			stopReason: "cancelled"
		});
		return true;
	}
	async applyPendingRuntimeTurnCancel(task, turn) {
		if (!task.state.pendingCancel || !turn.client.hasActivePrompt()) return false;
		const cancelled = await turn.client.requestCancelActivePrompt();
		if (cancelled) task.state.pendingCancel = false;
		return cancelled;
	}
	async saveCompletedRuntimeTurn(turn, _stopReason) {
		turn.record.acpSessionId = turn.activeSessionId;
		reconcileAgentSessionId(turn.record, turn.record.agentSessionId);
		turn.record.protocolVersion = turn.client.initializeResult?.protocolVersion;
		turn.record.agentCapabilities = turn.client.initializeResult?.agentCapabilities;
		turn.record.acpx = turn.acpxState;
		applyConversation(turn.record, turn.conversation);
		applyLifecycleSnapshotToRecord(turn.record, turn.client.getAgentLifecycleSnapshot());
		await this.options.sessionStore.save(turn.record);
	}
	failRuntimeTurn(task, error) {
		task.sessionReady.reject(error);
		const normalized = normalizeOutputError(error, { origin: "runtime" });
		task.settleResult({
			status: "failed",
			error: {
				message: normalized.message,
				...normalized.code ? { code: normalized.code } : {},
				...normalized.detailCode ? { detailCode: normalized.detailCode } : {},
				...normalized.retryable !== void 0 ? { retryable: normalized.retryable } : {}
			}
		});
	}
	async finalizeRuntimeTurn(task, turn) {
		task.state.turnActive = false;
		task.input.signal?.removeEventListener("abort", task.abortHandler);
		turn?.client.clearEventHandlers();
		if (!(turn ? await this.finalizeRuntimeTurnRecord(turn) : false)) await turn?.client.close().catch(() => {});
		if (turn) {
			this.activeControllers.delete(turn.record.acpxRecordId);
			this.closingActiveRecords.delete(turn.record.acpxRecordId);
		}
		task.queue.close();
	}
	async finalizeRuntimeTurnRecord(turn) {
		applyLifecycleSnapshotToRecord(turn.record, turn.client.getAgentLifecycleSnapshot());
		turn.record.acpx = turn.acpxState;
		applyConversation(turn.record, turn.conversation);
		turn.record.lastUsedAt = isoNow();
		await turn.liveCheckpoint.flush().catch(() => {});
		const closed = await this.refreshClosedState(turn.record);
		await this.options.sessionStore.save(turn.record).catch(() => {});
		if (closed) return false;
		return await this.retainPersistentClientAfterTurn({
			record: turn.record,
			client: turn.client
		});
	}
	async *runTurn(input) {
		const turn = this.startTurn(input);
		yield* turn.events;
		yield legacyTerminalEventFromTurnResult(await turn.result);
	}
	async getStatus(handle) {
		const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
		return {
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
	async setMode(handle, mode, sessionMode = "persistent") {
		const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
		const controller = this.activeControllers.get(record.acpxRecordId);
		let targetRecord = record;
		if (controller) await controller.setSessionMode(mode);
		else targetRecord = (await this.withRuntimeControlSession(record, sessionMode, async ({ client, sessionId }) => {
			await client.setSessionMode(sessionId, mode);
		})).record;
		setDesiredModeId(targetRecord, mode);
		await this.options.sessionStore.save(targetRecord);
	}
	async setConfigOption(handle, key, value, sessionMode = "persistent") {
		const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
		const controller = this.activeControllers.get(record.acpxRecordId);
		if (controller) {
			const { configId, response } = await controller.setResolvedSessionConfigOption(key, value);
			applyConfigOptionsToRecord(record, response);
			applyDesiredConfigOptionToRecord(record, configId, value);
			await this.options.sessionStore.save(record);
			return;
		}
		const result = await this.withRuntimeControlSession(record, sessionMode, async ({ client, sessionId, record: connectedRecord }) => {
			const configId = resolveSupportedConfigOptionId(connectedRecord, key);
			applyConfigOptionsToRecord(connectedRecord, await client.setSessionConfigOption(sessionId, configId, value));
			applyDesiredConfigOptionToRecord(connectedRecord, configId, value);
		});
		await this.options.sessionStore.save(result.record);
	}
	async cancel(handle) {
		await this.activeControllers.get(handle.acpxRecordId ?? handle.sessionKey)?.requestCancelActivePrompt();
	}
	async close(handle, options = {}) {
		const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
		if (this.activeControllers.has(record.acpxRecordId)) this.closingActiveRecords.add(record.acpxRecordId);
		await this.cancel(handle);
		if (options.discardPersistentState) {
			await this.closeBackendSession(record);
			record.acpx = {
				...record.acpx,
				reset_on_next_ensure: true
			};
		} else await this.closePendingPersistentClient(record.acpxRecordId);
		record.closed = true;
		record.closedAt = isoNow();
		await this.options.sessionStore.save(record);
	}
	async closeBackendSession(record) {
		const pendingClient = await this.readPendingPersistentClient(record, { consume: true });
		const client = pendingClient ?? this.createClient({
			agentCommand: record.agentCommand,
			cwd: record.cwd,
			mcpServers: [...this.options.mcpServers ?? []],
			permissionMode: this.options.permissionMode,
			nonInteractivePermissions: this.options.nonInteractivePermissions,
			onPermissionRequest: this.options.onPermissionRequest,
			verbose: this.options.verbose
		});
		try {
			if (!pendingClient) await withTimeout(client.start(), this.options.timeoutMs);
			if (!client.supportsCloseSession()) throw new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", `Agent does not support session/close for ${record.acpxRecordId}.`);
			await withTimeout(client.closeSession(record.acpSessionId), this.options.timeoutMs);
		} catch (error) {
			if (isUnsupportedSessionCloseError(error)) throw new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", `Agent does not support session/close for ${record.acpxRecordId}.`, { cause: error });
			if (isAcpResourceNotFoundError(error)) return;
			throw error;
		} finally {
			await client.close().catch(() => {});
		}
	}
	async requireRecord(sessionId) {
		const record = await this.options.sessionStore.load(sessionId);
		if (!record) throw new Error(`ACP session not found: ${sessionId}`);
		return record;
	}
};
//#endregion
//#region src/runtime/public/file-session-store.ts
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
		await fs.mkdir(this.sessionDir, { recursive: true });
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
		return parseSessionRecord(parsed) ?? void 0;
	}
	async save(record) {
		await this.ensureDir();
		const persisted = serializeSessionRecordForDisk(record);
		assertPersistedKeyPolicy(persisted);
		const file = this.filePath(record.acpxRecordId);
		const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
		const payload = JSON.stringify(persisted, null, 2);
		await fs.writeFile(tempFile, `${payload}\n`, "utf8");
		await fs.rename(tempFile, file);
	}
};
function createFileSessionStore(options) {
	return new FileSessionStore(path.resolve(options.stateDir));
}
//#endregion
//#region src/runtime/public/handle-state.ts
const ACPX_RUNTIME_HANDLE_PREFIX = "acpx:v2:";
function encodeAcpxRuntimeHandleState(state) {
	return `${ACPX_RUNTIME_HANDLE_PREFIX}${Buffer.from(JSON.stringify(state), "utf8").toString("base64url")}`;
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
//#endregion
//#region src/runtime/public/probe.ts
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
	const agentCommand = options.agentRegistry.resolve(agentName);
	const client = createProbeClient(options, agentCommand, deps);
	try {
		await client.start();
		return {
			ok: true,
			message: "embedded ACP runtime ready",
			details: [
				`agent=${agentName}`,
				`command=${agentCommand}`,
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
				`command=${agentCommand}`,
				`cwd=${options.cwd}`,
				formatRuntimeDetail(error)
			]
		};
	} finally {
		await client.close().catch(() => {});
	}
}
function createProbeClient(options, agentCommand, deps) {
	const clientOptions = {
		agentCommand,
		cwd: options.cwd,
		mcpServers: [...options.mcpServers ?? []],
		permissionMode: options.permissionMode,
		nonInteractivePermissions: options.nonInteractivePermissions,
		verbose: options.verbose
	};
	return deps.clientFactory?.(clientOptions) ?? new AcpClient(clientOptions);
}
//#endregion
//#region src/runtime.ts
const ACPX_BACKEND_ID = "acpx";
const ACPX_CAPABILITIES = { controls: [
	"session/set_mode",
	"session/set_config_option",
	"session/status"
] };
function createAgentRegistry(params) {
	return {
		resolve(agentName) {
			return resolveAgentCommand(agentName, params?.overrides);
		},
		list() {
			return listBuiltInAgents(params?.overrides);
		}
	};
}
var AcpxRuntime = class {
	options;
	testOptions;
	healthy = false;
	manager = null;
	managerPromise = null;
	constructor(options, testOptions) {
		this.options = options;
		this.testOptions = testOptions;
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
	async ensureSession(input) {
		const sessionName = input.sessionKey.trim();
		if (!sessionName) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
		const agent = input.agent.trim();
		if (!agent) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP agent id is required.");
		const record = await (await this.getManager()).ensureSession({
			sessionKey: sessionName,
			agent,
			mode: input.mode,
			cwd: input.cwd ?? this.options.cwd,
			resumeSessionId: input.resumeSessionId,
			sessionOptions: input.sessionOptions
		});
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
			name: sessionName,
			agent,
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
			signal: input.signal
		}));
		return {
			requestId: input.requestId,
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
			signal: input.signal
		});
	}
	async getCapabilities(input) {
		if (!input?.handle) return ACPX_CAPABILITIES;
		const { handle } = this.resolveManagerHandle(input.handle);
		const record = await this.options.sessionStore.load(handle.acpxRecordId ?? handle.sessionKey);
		if (!record?.acpx?.config_options) return ACPX_CAPABILITIES;
		const configOptionKeys = Array.from(new Set(record.acpx.config_options.map((option) => option.id).filter((id) => typeof id === "string" && id.trim().length > 0)));
		return {
			...ACPX_CAPABILITIES,
			...configOptionKeys.length > 0 ? { configOptionKeys } : {}
		};
	}
	async getStatus(input) {
		const { handle } = this.resolveManagerHandle(input.handle);
		return await (await this.getManager()).getStatus(handle);
	}
	async setMode(input) {
		const { handle, state } = this.resolveManagerHandle(input.handle);
		await (await this.getManager()).setMode(handle, input.mode, state.mode);
	}
	async setConfigOption(input) {
		const { handle, state } = this.resolveManagerHandle(input.handle);
		await (await this.getManager()).setConfigOption(handle, input.key, input.value, state.mode);
	}
	async cancel(input) {
		const { handle } = this.resolveManagerHandle(input.handle);
		await (await this.getManager()).cancel(handle);
	}
	async close(input) {
		const { handle } = this.resolveManagerHandle(input.handle);
		await (await this.getManager()).close(handle, { discardPersistentState: input.discardPersistentState });
	}
	async getManager() {
		if (this.manager) return this.manager;
		if (!this.managerPromise) this.managerPromise = Promise.resolve(this.testOptions?.managerFactory?.(this.options) ?? new AcpRuntimeManager(this.options)).then((manager) => {
			this.manager = manager;
			return manager;
		});
		return await this.managerPromise;
	}
	async runProbe() {
		return await (this.testOptions?.probeRunner?.(this.options) ?? probeRuntime(this.options));
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
//#endregion
export { ACPX_BACKEND_ID, AcpRuntimeError, AcpxRuntime, DEFAULT_AGENT_NAME, REQUESTED_MODEL_UNSUPPORTED_ERROR_CODE, REQUESTED_MODEL_UNSUPPORTED_REASONS, RequestedModelUnsupportedError, createAcpRuntime, createAgentRegistry, createFileSessionStore, createRuntimeStore, decodeAcpxRuntimeHandleState, encodeAcpxRuntimeHandleState, isAcpRuntimeError, isRequestedModelUnsupportedError };

//# sourceMappingURL=runtime.js.map