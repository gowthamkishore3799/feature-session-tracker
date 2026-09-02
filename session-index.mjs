import { createReadStream } from "node:fs"
import { open, opendir, readFile, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"

const DEFAULT_SESSION_LIMIT_PER_PROVIDER = Number.POSITIVE_INFINITY
const MAX_METADATA_LINES = 240
const MAX_PULL_REQUEST_URLS_PER_SESSION = 20
const SESSION_TAIL_BYTES = 256 * 1024
const sessionMetadataCache = new Map()

async function codexThreadTitles(homeDirectory) {
	const databasePath = path.join(homeDirectory, ".codex", "state_5.sqlite")
	const titles = new Map()
	let DatabaseSync
	try {
		;({ DatabaseSync } = await import("node:sqlite"))
	} catch {
		DatabaseSync = null
	}

	let database
	try {
		if (!DatabaseSync) throw new Error("SQLite is unavailable")
		database = new DatabaseSync(databasePath, { readOnly: true })
		const rows = database
			.prepare(
				`SELECT id,
				        COALESCE(NULLIF(TRIM(name), ''), NULLIF(TRIM(title), '')) AS display_title
				 FROM threads
				 WHERE COALESCE(NULLIF(TRIM(name), ''), NULLIF(TRIM(title), '')) IS NOT NULL`,
			)
			.all()
		for (const row of rows) {
			const title = titleFromText(row.display_title)
			if (title) titles.set(String(row.id), { aliases: [], title })
		}
	} catch {
		// The session index below remains available when SQLite cannot be opened.
	} finally {
		database?.close()
	}

	try {
		const index = await readFile(
			path.join(homeDirectory, ".codex", "session_index.jsonl"),
			"utf8",
		)
		for (const line of index.split(/\r?\n/u)) {
			if (!line.trim()) continue
			try {
				const record = JSON.parse(line)
				const id = typeof record.id === "string" ? record.id : ""
				const title = titleFromText(record.thread_name)
				if (!id || !title) continue
				const previous = titles.get(id)
				titles.set(id, {
					aliases: [previous?.title, ...(previous?.aliases ?? [])].filter(
						alias => alias && alias !== title,
					),
					title,
				})
			} catch {
				// Ignore partially written or older unsupported index records.
			}
		}
	} catch {
		// Older Codex versions may not have a session index.
	}

	return titles
}

function textFromContent(content) {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.map(part => {
			if (typeof part === "string") return part
			if (part && typeof part === "object") {
				if (typeof part.text === "string") return part.text
				if (typeof part.content === "string") return part.content
			}
			return ""
		})
		.filter(Boolean)
		.join(" ")
}

function titleFromText(value) {
	if (typeof value !== "string") return ""
	const normalized = value
		.replace(/<[^>]+>/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
	if (!normalized) return ""
	return normalized.length > 96
		? `${normalized.slice(0, 93).trimEnd()}…`
		: normalized
}

function launchTokenFromText(value) {
	if (typeof value !== "string") return ""
	return (
		value.match(/<!--\s*feature-tracker-launch:([0-9a-f-]{36})\s*-->/iu)?.[1] ??
		""
	)
}

function pullRequestUrlsFromText(value) {
	if (typeof value !== "string") return []
	const urls = []
	const seenUrls = new Set()
	const marker = /<!--\s*feature-tracker-pr:\s*(https:\/\/[^\s<>]+?)\s*-->/giu
	for (const match of value.matchAll(marker)) {
		const normalizedUrl = normalizePullRequestUrl(match[1])
		if (!normalizedUrl) continue
		if (seenUrls.has(normalizedUrl)) continue
		seenUrls.add(normalizedUrl)
		urls.push(normalizedUrl)
		if (urls.length >= MAX_PULL_REQUEST_URLS_PER_SESSION) break
	}
	return urls
}

function normalizePullRequestUrl(value) {
	let url
	try {
		url = new URL(value)
	} catch {
		return ""
	}
	if (url.protocol !== "https:") return ""
	if (
		!/(?:^|\/)(?:merge_requests|pull|pull-requests|pullrequest)\/\d+(?:\/|$)/iu.test(
			url.pathname,
		)
	) {
		return ""
	}
	url.hash = ""
	return url.toString()
}

function pullRequestUrlsFromEvidence(value) {
	if (typeof value !== "string") return []
	const urls = []
	const candidates =
		/https:\/\/[^\s<>"'`]+?\/(?:merge_requests|pull|pull-requests|pullrequest)\/\d+/giu
	for (const match of value.matchAll(candidates)) {
		const normalizedUrl = normalizePullRequestUrl(match[0])
		if (normalizedUrl && !urls.includes(normalizedUrl)) urls.push(normalizedUrl)
		if (urls.length >= MAX_PULL_REQUEST_URLS_PER_SESSION) break
	}
	return urls
}

function codexAssistantText(record) {
	if (
		record?.type === "event_msg" &&
		record.payload?.type === "agent_message"
	) {
		return typeof record.payload.message === "string"
			? record.payload.message
			: ""
	}
	if (
		record?.type === "response_item" &&
		record.payload?.type === "message" &&
		record.payload?.role === "assistant"
	) {
		return textFromContent(record.payload.content)
	}
	return ""
}

function claudeAssistantText(record) {
	if (record?.type !== "assistant") return ""
	return textFromContent(record.message?.content)
}

function appendPullRequestUrls(summary, value) {
	const urls = pullRequestUrlsFromText(value)
	if (urls.length === 0) return
	summary.pullRequestUrls = [
		...new Set([...summary.pullRequestUrls, ...urls]),
	].slice(0, MAX_PULL_REQUEST_URLS_PER_SESSION)
}

function appendPullRequestEvidenceUrls(summary, value) {
	const urls = pullRequestUrlsFromEvidence(value)
	if (urls.length === 0) return
	summary.pullRequestUrls = [
		...new Set([...summary.pullRequestUrls, ...urls]),
	].slice(0, MAX_PULL_REQUEST_URLS_PER_SESSION)
}

function decodeJavaScriptStringLiteral(value) {
	if (value.startsWith('"')) {
		try {
			return JSON.parse(value)
		} catch {
			return ""
		}
	}
	return value.slice(1, -1).replace(/\\([\\'"`nrt])/gu, (_match, character) => {
		if (character === "n") return "\n"
		if (character === "r") return "\r"
		if (character === "t") return "\t"
		return character
	})
}

function commandValuesFromToolInput(value) {
	if (value && typeof value === "object") {
		return typeof value.cmd === "string" ? [value.cmd] : []
	}
	if (typeof value !== "string") return []
	try {
		const parsed = JSON.parse(value)
		if (
			parsed &&
			typeof parsed === "object" &&
			typeof parsed.cmd === "string"
		) {
			return [parsed.cmd]
		}
	} catch {
		// Code-mode tool calls contain JavaScript rather than JSON.
	}
	const commands = []
	const commandLiteral =
		/\bcmd\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/gu
	for (const match of value.matchAll(commandLiteral)) {
		const command = decodeJavaScriptStringLiteral(match[1])
		if (command) commands.push(command)
	}
	return commands
}

function commandCreatesPullRequest(value) {
	return /(?:^|[\n\r;&|])\s*(?:(?:env\s+)?(?:[A-Z_][A-Z0-9_]*=\S+\s+)*)?(?:gh\s+pr|glab\s+mr)\s+create(?:\s|$)/iu.test(
		value,
	)
}

function toolOutputText(value) {
	if (typeof value === "string") return value
	if (Array.isArray(value)) return textFromContent(value)
	if (!value || typeof value !== "object") return ""
	return [value.output, value.text, value.content]
		.map(toolOutputText)
		.filter(Boolean)
		.join(" ")
}

function appendCodexPullRequestEvidence(summary, record) {
	if (record?.type !== "response_item" || !record.payload) return
	const payload = record.payload
	if (["custom_tool_call", "function_call"].includes(payload.type)) {
		const toolName = typeof payload.name === "string" ? payload.name : ""
		const createsPullRequest =
			toolName.toLowerCase().includes("create_pull_request") ||
			(["exec", "exec_command"].some(name => toolName.endsWith(name)) &&
				commandValuesFromToolInput(payload.input ?? payload.arguments).some(
					commandCreatesPullRequest,
				))
		if (createsPullRequest && typeof payload.call_id === "string") {
			summary.prCreationCallIds.add(payload.call_id)
		}
		return
	}
	if (
		["custom_tool_call_output", "function_call_output"].includes(
			payload.type,
		) &&
		summary.prCreationCallIds.has(payload.call_id)
	) {
		appendPullRequestEvidenceUrls(summary, toolOutputText(payload.output))
	}
}

function appendClaudePullRequestEvidence(summary, record) {
	if (record?.type !== "pr-link") return
	appendPullRequestEvidenceUrls(summary, record.prUrl)
}

function activityState(updatedAt, now) {
	const age = Math.max(0, now.getTime() - new Date(updatedAt).getTime())
	if (age <= 5 * 60 * 1000) return "active"
	if (age <= 24 * 60 * 60 * 1000) return "recent"
	return "quiet"
}

async function collectJsonlFiles(root, archived = false) {
	const files = []
	async function visit(directory) {
		let entries
		try {
			entries = await opendir(directory)
		} catch (error) {
			if (error?.code === "ENOENT") return
			throw error
		}

		for await (const entry of entries) {
			const entryPath = path.join(directory, entry.name)
			if (entry.isDirectory()) {
				await visit(entryPath)
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				files.push({ archived, path: entryPath })
			}
		}
	}

	await visit(root)
	return files
}

async function withConcurrency(values, concurrency, worker) {
	const output = new Array(values.length)
	let nextIndex = 0

	async function run() {
		while (nextIndex < values.length) {
			const index = nextIndex
			nextIndex += 1
			output[index] = await worker(values[index], index)
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(concurrency, values.length) }, () => run()),
	)
	return output
}

async function candidateFiles(roots, limit) {
	const files = (
		await Promise.all(
			roots.map(root => collectJsonlFiles(root.path, root.archived)),
		)
	).flat()
	const withStats = await withConcurrency(files, 16, async file => {
		try {
			return { ...file, stats: await stat(file.path) }
		} catch (error) {
			if (error?.code === "ENOENT") return null
			throw error
		}
	})

	return withStats
		.filter(Boolean)
		.sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs)
		.slice(0, limit)
}

function parseCodexRecord(record, summary) {
	appendPullRequestUrls(summary, codexAssistantText(record))
	appendCodexPullRequestEvidence(summary, record)
	if (record?.type === "session_meta" && record.payload) {
		if (summary.hasCodexSessionMeta) return
		summary.hasCodexSessionMeta = true
		summary.sessionId =
			record.payload.id ?? record.payload.session_id ?? summary.sessionId
		summary.cwd = record.payload.cwd ?? summary.cwd
		summary.branch = record.payload.git?.branch ?? summary.branch
		summary.startedAt =
			record.payload.timestamp ?? record.timestamp ?? summary.startedAt
		summary.forkedFromId ||= record.payload.forked_from_id ?? ""
		summary.threadSource ||= record.payload.thread_source ?? ""
		return
	}

	if (record?.type === "event_msg" && record.payload?.type === "user_message") {
		const message = record.payload.message
		summary.firstPrompt ||= titleFromText(message)
		summary.launchToken ||= launchTokenFromText(message)
		return
	}

	if (
		record?.type === "event_msg" &&
		["thread_name_updated", "session_name_updated"].includes(
			record.payload?.type,
		)
	) {
		summary.customTitle = titleFromText(
			record.payload.name ?? record.payload.title,
		)
	}
}

function parseClaudeRecord(record, summary) {
	appendPullRequestUrls(summary, claudeAssistantText(record))
	appendClaudePullRequestEvidence(summary, record)
	if (typeof record?.sessionId === "string") {
		summary.sessionId = record.sessionId
	}
	if (typeof record?.cwd === "string") summary.cwd ||= record.cwd
	if (typeof record?.gitBranch === "string") {
		summary.branch ||= record.gitBranch
	}
	if (typeof record?.timestamp === "string") {
		summary.startedAt ||= record.timestamp
	}
	if (
		!summary.relatedGroupId &&
		!record?.isSidechain &&
		typeof record?.uuid === "string" &&
		record.parentUuid == null
	) {
		summary.relatedGroupId = `claude-root:${record.uuid}`
	}
	if (record?.type === "ai-title") {
		summary.aiTitle = titleFromText(record.aiTitle)
	}
	if (record?.type === "custom-title") {
		summary.customTitle = titleFromText(record.customTitle)
	}
	if (record?.type === "user" && !record.isSidechain) {
		const message = textFromContent(record.message?.content)
		summary.firstPrompt ||= titleFromText(message)
		summary.launchToken ||= launchTokenFromText(message)
	}
}

async function pullRequestUrlsFromSessionTail(file, provider) {
	let handle
	try {
		handle = await open(file.path, "r")
		const currentStats = await handle.stat()
		const byteCount = Math.min(currentStats.size, SESSION_TAIL_BYTES)
		if (byteCount === 0) return []
		const buffer = Buffer.alloc(byteCount)
		const offset = Math.max(0, currentStats.size - byteCount)
		const { bytesRead } = await handle.read(buffer, 0, byteCount, offset)
		let tail = buffer.subarray(0, bytesRead).toString("utf8")
		if (offset > 0) {
			const firstNewline = tail.indexOf("\n")
			if (firstNewline >= 0) tail = tail.slice(firstNewline + 1)
		}

		const tailSummary = {
			prCreationCallIds: new Set(),
			pullRequestUrls: [],
		}
		for (const line of tail.split(/\r?\n/u)) {
			if (!line.trim()) continue
			try {
				const record = JSON.parse(line)
				const text =
					provider === "codex"
						? codexAssistantText(record)
						: claudeAssistantText(record)
				appendPullRequestUrls(tailSummary, text)
				if (provider === "codex") {
					appendCodexPullRequestEvidence(tailSummary, record)
				} else {
					appendClaudePullRequestEvidence(tailSummary, record)
				}
			} catch {
				// Ignore partial records while an agent is still writing its history.
			}
		}
		return [...new Set(tailSummary.pullRequestUrls)].slice(
			0,
			MAX_PULL_REQUEST_URLS_PER_SESSION,
		)
	} catch (error) {
		if (error?.code === "ENOENT") return []
		throw error
	} finally {
		await handle?.close()
	}
}

async function parseSessionFile(file, provider, now) {
	const signature = `${file.stats.mtimeMs}:${file.stats.size}`
	const cached = sessionMetadataCache.get(file.path)
	if (cached?.signature === signature) {
		return {
			...cached.summary,
			activity: activityState(cached.summary.updatedAt, now),
		}
	}

	const summary = {
		aiTitle: "",
		branch: "",
		customTitle: "",
		cwd: "",
		firstPrompt: "",
		forkedFromId: "",
		hasCodexSessionMeta: false,
		launchToken: "",
		prCreationCallIds: new Set(),
		pullRequestUrls: [],
		relatedGroupId: "",
		sessionId: path.basename(file.path, ".jsonl"),
		startedAt: "",
		threadSource: "",
	}
	const input = createReadStream(file.path, { encoding: "utf8" })
	const lines = readline.createInterface({ crlfDelay: Infinity, input })
	let lineCount = 0

	try {
		for await (const line of lines) {
			lineCount += 1
			if (!line.trim()) continue
			try {
				const record = JSON.parse(line)
				if (provider === "codex") parseCodexRecord(record, summary)
				else parseClaudeRecord(record, summary)
			} catch {
				// A partially written final line is normal while a session is active.
			}
			if (lineCount >= MAX_METADATA_LINES) break
		}
	} finally {
		lines.close()
		input.destroy()
	}
	summary.pullRequestUrls = [
		...new Set([
			...summary.pullRequestUrls,
			...(await pullRequestUrlsFromSessionTail(file, provider)),
		]),
	].slice(0, MAX_PULL_REQUEST_URLS_PER_SESSION)

	const updatedAt = file.stats.mtime.toISOString()
	const title =
		summary.customTitle ||
		summary.aiTitle ||
		summary.firstPrompt ||
		`${provider === "codex" ? "Codex" : "Claude Code"} session`
	const normalized = {
		activity: activityState(updatedAt, now),
		archived: file.archived,
		branch: summary.branch,
		cwd: summary.cwd,
		forkedFromId:
			provider === "codex" && summary.threadSource === "user"
				? summary.forkedFromId
				: "",
		id: `${provider}:${summary.sessionId}`,
		launchToken: summary.launchToken,
		pullRequestUrls: summary.pullRequestUrls,
		provider,
		relatedGroupId: provider === "claude" ? summary.relatedGroupId : "",
		resumeCommand:
			provider === "codex"
				? `codex resume ${summary.sessionId}`
				: `claude --resume ${summary.sessionId}`,
		sessionId: summary.sessionId,
		startedAt: summary.startedAt || updatedAt,
		title,
		updatedAt,
		workspace: summary.cwd ? path.basename(summary.cwd) : "Unknown workspace",
	}

	sessionMetadataCache.set(file.path, { signature, summary: normalized })
	return normalized
}

export function relatedSessionIds(seedIds, sessions) {
	const relatedIds = new Set(seedIds)
	const availableIds = new Set(sessions.map(session => session.id))
	let changed = true

	while (changed) {
		changed = false
		const activeClaudeGroups = new Set(
			sessions
				.filter(session => session.relatedGroupId && relatedIds.has(session.id))
				.map(session => session.relatedGroupId),
		)

		for (const session of sessions) {
			if (
				session.relatedGroupId &&
				activeClaudeGroups.has(session.relatedGroupId) &&
				!relatedIds.has(session.id)
			) {
				relatedIds.add(session.id)
				changed = true
			}

			if (!session.forkedFromId) continue
			const parentId = `${session.provider}:${session.forkedFromId}`
			if (relatedIds.has(parentId) && !relatedIds.has(session.id)) {
				relatedIds.add(session.id)
				changed = true
			}
			if (
				relatedIds.has(session.id) &&
				availableIds.has(parentId) &&
				!relatedIds.has(parentId)
			) {
				relatedIds.add(parentId)
				changed = true
			}
		}
	}

	return [...relatedIds]
}

export async function scanAgentSessions({
	homeDirectory = os.homedir(),
	limitPerProvider = DEFAULT_SESSION_LIMIT_PER_PROVIDER,
	now = new Date(),
} = {}) {
	const codexRoots = [
		{ archived: false, path: path.join(homeDirectory, ".codex", "sessions") },
		{
			archived: true,
			path: path.join(homeDirectory, ".codex", "archived_sessions"),
		},
	]
	const claudeRoots = [
		{ archived: false, path: path.join(homeDirectory, ".claude", "projects") },
	]

	const [codexFiles, claudeFiles, codexTitles] = await Promise.all([
		candidateFiles(codexRoots, limitPerProvider),
		candidateFiles(claudeRoots, limitPerProvider),
		codexThreadTitles(homeDirectory),
	])
	const [parsedCodexSessions, claudeSessions] = await Promise.all([
		withConcurrency(codexFiles, 8, file =>
			parseSessionFile(file, "codex", now),
		),
		withConcurrency(claudeFiles, 8, file =>
			parseSessionFile(file, "claude", now),
		),
	])
	const codexSessions = parsedCodexSessions.map(session => {
		const indexed = codexTitles.get(session.sessionId)
		if (!indexed) return session
		const titleAliases = [
			...(indexed.aliases ?? []),
			session.title,
			...(session.titleAliases ?? []),
		].filter((title, index, values) => {
			return title && title !== indexed.title && values.indexOf(title) === index
		})
		return {
			...session,
			title: indexed.title,
			titleAliases,
		}
	})

	const sorted = [...codexSessions, ...claudeSessions].sort((left, right) => {
		const recency =
			new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
		if (recency !== 0) return recency
		return Number(left.archived) - Number(right.archived)
	})
	const seenSessionIds = new Set()
	const uniqueSessions = sorted.filter(session => {
		if (seenSessionIds.has(session.id)) return false
		seenSessionIds.add(session.id)
		return true
	})
	const claudeGroupCounts = new Map()
	for (const session of uniqueSessions) {
		if (!session.relatedGroupId) continue
		claudeGroupCounts.set(
			session.relatedGroupId,
			(claudeGroupCounts.get(session.relatedGroupId) ?? 0) + 1,
		)
	}
	return uniqueSessions.map(session => ({
		...session,
		isFork:
			Boolean(session.forkedFromId) ||
			(claudeGroupCounts.get(session.relatedGroupId) ?? 0) > 1,
	}))
}

export const internals = {
	activityState,
	codexThreadTitles,
	launchTokenFromText,
	parseSessionFile,
	pullRequestUrlsFromText,
	pullRequestUrlsFromEvidence,
	relatedSessionIds,
	titleFromText,
}
