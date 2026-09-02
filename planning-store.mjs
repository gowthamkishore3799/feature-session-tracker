import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { relatedSessionIds } from "./session-index.mjs"

const ALLOWED_AGENTS = new Set(["either", "codex", "claude"])
const ALLOWED_PRIORITIES = new Set(["low", "medium", "high"])
const ALLOWED_STATUSES = new Set(["planned", "in_progress", "blocked", "done"])
const MAX_LINKED_THREADS = 500
const MAX_PENDING_LAUNCHES = 20
const MAX_MONITOR_RUNS = 50
const MAX_MONITOR_ACTIVITY_ENTRIES = 80
const MAX_MONITOR_ACTIVITY_TEXT = 40_000
const MAX_PULL_REQUESTS = 100
const MAX_STATUS_HISTORY = 1_000
const PENDING_LAUNCH_TTL_MS = 24 * 60 * 60 * 1000
const PR_AGENT_STATUSES = new Set([
	"attention",
	"healthy",
	"not_configured",
	"pending",
	"ready",
	"unavailable",
	"unsupported",
])
const MONITOR_RUN_STATUSES = new Set([
	"blocked",
	"failed",
	"healthy",
	"issue",
	"pending",
	"running",
])
const MONITOR_ACTIVITY_KINDS = new Set([
	"command",
	"error",
	"message",
	"progress",
	"result",
	"status",
])

function cleanText(value, maximumLength, fieldName) {
	if (typeof value !== "string") {
		throw new TypeError(`${fieldName} must be text`)
	}
	const normalized = value.replace(/\s+/gu, " ").trim()
	if (!normalized) throw new TypeError(`${fieldName} is required`)
	if (normalized.length > maximumLength) {
		throw new TypeError(
			`${fieldName} must be ${maximumLength} characters or less`,
		)
	}
	return normalized
}

function cleanDescription(value) {
	if (value == null || value === "") return ""
	if (typeof value !== "string") throw new TypeError("Description must be text")
	const normalized = value.trim()
	if (normalized.length > 2_000) {
		throw new TypeError("Description must be 2000 characters or less")
	}
	return normalized
}

function cleanWorkspacePath(value) {
	if (value == null || value === "") return ""
	if (typeof value !== "string") {
		throw new TypeError("Workspace folder must be text")
	}
	const normalized = value.trim()
	if (normalized.length > 4_096) {
		throw new TypeError("Workspace folder must be 4096 characters or less")
	}
	if (!path.isAbsolute(normalized)) {
		throw new TypeError("Workspace folder must be an absolute path")
	}
	return path.normalize(normalized)
}

function cleanPendingLaunches(value) {
	if (!Array.isArray(value)) return []
	return value
		.filter(
			launch =>
				launch &&
				typeof launch === "object" &&
				["codex", "claude"].includes(launch.provider) &&
				typeof launch.id === "string" &&
				launch.id.length <= 160 &&
				typeof launch.startedAt === "string" &&
				typeof launch.token === "string" &&
				launch.token.length <= 160,
		)
		.slice(-MAX_PENDING_LAUNCHES)
		.map(launch => ({
			id: launch.id,
			provider: launch.provider,
			pullRequestId:
				typeof launch.pullRequestId === "string" &&
				launch.pullRequestId.length <= 160
					? launch.pullRequestId
					: "",
			sessionId:
				typeof launch.sessionId === "string" && launch.sessionId.length <= 160
					? launch.sessionId
					: "",
			startedAt: launch.startedAt,
			sessionName:
				typeof launch.sessionName === "string" && launch.sessionName.trim()
					? cleanText(launch.sessionName, 100, "Thread name")
					: "",
			token: launch.token,
		}))
}

function cleanMonitorActivity(value) {
	if (!Array.isArray(value)) return []
	const activity = []
	let textBudget = MAX_MONITOR_ACTIVITY_TEXT
	for (const entry of value.slice(0, MAX_MONITOR_ACTIVITY_ENTRIES)) {
		if (!entry || typeof entry !== "object" || textBudget <= 0) continue
		const title = optionalAgentText(entry.title, Math.min(160, textBudget))
		if (!title) continue
		textBudget -= title.length
		const detail = optionalAgentText(entry.detail, Math.min(2_000, textBudget))
		textBudget -= detail.length
		activity.push({
			detail,
			kind: MONITOR_ACTIVITY_KINDS.has(entry.kind) ? entry.kind : "status",
			title,
		})
	}
	return activity
}

function cleanMonitorRuns(value) {
	if (!Array.isArray(value)) return []
	return value
		.filter(
			run =>
				run &&
				typeof run === "object" &&
				typeof run.id === "string" &&
				run.id.length <= 160 &&
				typeof run.sandboxId === "string" &&
				run.sandboxId.length <= 255 &&
				typeof run.startedAt === "string" &&
				Number.isFinite(new Date(run.startedAt).getTime()),
		)
		.slice(-MAX_MONITOR_RUNS)
		.map(run => ({
			activity: cleanMonitorActivity(run.activity),
			commandId:
				typeof run.commandId === "string" ? run.commandId.slice(0, 255) : "",
			completedAt:
				typeof run.completedAt === "string" &&
				Number.isFinite(new Date(run.completedAt).getTime())
					? run.completedAt
					: "",
			error: optionalAgentText(run.error, 500),
			expiresAt:
				typeof run.expiresAt === "string" &&
				Number.isFinite(new Date(run.expiresAt).getTime())
					? run.expiresAt
					: "",
			id: run.id,
			provider: "vercel",
			sandboxId: run.sandboxId,
			startedAt: run.startedAt,
			status: MONITOR_RUN_STATUSES.has(run.status) ? run.status : "running",
			summary: optionalAgentText(run.summary, 1_000),
			verifiedIssueCount: Math.max(
				0,
				Math.min(5, Number(run.verifiedIssueCount) || 0),
			),
			workspacePath: cleanWorkspacePath(run.workspacePath),
		}))
}

function cleanStatusHistory(value, item) {
	const entries = Array.isArray(value)
		? value
				.filter(
					entry =>
						entry &&
						typeof entry === "object" &&
						(entry.from === "" || ALLOWED_STATUSES.has(entry.from)) &&
						ALLOWED_STATUSES.has(entry.to) &&
						typeof entry.changedAt === "string" &&
						Number.isFinite(new Date(entry.changedAt).getTime()),
				)
				.slice(-MAX_STATUS_HISTORY)
				.map(entry => ({
					changedAt: entry.changedAt,
					from: entry.from,
					source:
						typeof entry.source === "string" && entry.source.length <= 40
							? entry.source
							: "manual",
					to: entry.to,
					triggerId:
						typeof entry.triggerId === "string" && entry.triggerId.length <= 160
							? entry.triggerId
							: "",
				}))
		: []
	if (entries.length > 0) return entries
	return [
		{
			changedAt: item.updatedAt || item.createdAt || new Date(0).toISOString(),
			from: "",
			source: "snapshot",
			to: item.status,
			triggerId: "",
		},
	]
}

function addStatusHistory(item, entry) {
	item.statusHistory = [...item.statusHistory, entry].slice(-MAX_STATUS_HISTORY)
}

function cleanSessionNames(value) {
	if (value == null) return {}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("Thread names must be a map")
	}
	return Object.fromEntries(
		Object.entries(value)
			.filter(
				([sessionId, name]) =>
					typeof sessionId === "string" &&
					sessionId.length <= 160 &&
					typeof name === "string" &&
					name.trim(),
			)
			.slice(0, MAX_LINKED_THREADS)
			.map(([sessionId, name]) => [
				sessionId,
				cleanText(name, 100, "Thread name"),
			]),
	)
}

function defaultPullRequestLabel(url) {
	const match = url.pathname.match(
		/\/(?:pull|pull-requests|merge_requests)\/(\d+)(?:\/|$)/u,
	)
	return match ? `PR #${match[1]}` : url.hostname
}

function optionalAgentText(value, maximumLength) {
	return typeof value === "string" ? value.trim().slice(0, maximumLength) : ""
}

function cleanArchivedAt(value) {
	if (value == null || value === "") return ""
	if (
		typeof value !== "string" ||
		!Number.isFinite(new Date(value).getTime())
	) {
		throw new TypeError("Task archive date is invalid")
	}
	return value
}

function cleanGcpTarget(value) {
	if (value == null) return null
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("GCP target must be a project, region, and service")
	}
	const target = {
		project: optionalAgentText(value.project, 63),
		region: optionalAgentText(value.region, 63),
		service: optionalAgentText(value.service, 63),
	}
	if (!target.project && !target.region && !target.service) return null
	if (!target.project || !target.region || !target.service) {
		throw new TypeError("Enter the GCP project, region, and Cloud Run service")
	}
	for (const [field, identifier] of Object.entries(target)) {
		if (!/^[a-z0-9][a-z0-9-]*$/u.test(identifier)) {
			throw new TypeError(`GCP ${field} contains unsupported characters`)
		}
	}
	return target
}

function cleanAgentStatus(value, fallback = "unavailable") {
	return PR_AGENT_STATUSES.has(value) ? value : fallback
}

function cleanCheckNames(value) {
	return Array.isArray(value)
		? value
				.slice(0, 5)
				.map(name => optionalAgentText(name, 160))
				.filter(Boolean)
		: []
}

function cleanPrAgentSnapshot(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null
	const checkedAt = optionalAgentText(value.checkedAt, 40)
	if (!Number.isFinite(new Date(checkedAt).getTime())) return null
	const githubValue =
		value.github && typeof value.github === "object" ? value.github : {}
	const checksValue =
		githubValue.checks && typeof githubValue.checks === "object"
			? githubValue.checks
			: {}
	const github = {
		checks: {
			failing: Math.max(0, Number(checksValue.failing) || 0),
			failingNames: cleanCheckNames(checksValue.failingNames),
			passing: Math.max(0, Number(checksValue.passing) || 0),
			pending: Math.max(0, Number(checksValue.pending) || 0),
			pendingNames: cleanCheckNames(checksValue.pendingNames),
			total: Math.max(0, Number(checksValue.total) || 0),
		},
		error: optionalAgentText(githubValue.error, 500),
		headRefName: optionalAgentText(githubValue.headRefName, 300),
		headRefOid: optionalAgentText(githubValue.headRefOid, 80),
		isDraft: githubValue.isDraft === true,
		mergeStateStatus: optionalAgentText(githubValue.mergeStateStatus, 40),
		mergedAt: optionalAgentText(githubValue.mergedAt, 40),
		number: Math.max(0, Number(githubValue.number) || 0),
		reviewDecision: optionalAgentText(githubValue.reviewDecision, 80),
		state: optionalAgentText(githubValue.state, 40),
		status: cleanAgentStatus(githubValue.status),
		title: optionalAgentText(githubValue.title, 200),
		url: optionalAgentText(githubValue.url, 2_048),
	}
	const gcpValue = value.gcp && typeof value.gcp === "object" ? value.gcp : {}
	const deploymentValue =
		gcpValue.deployment && typeof gcpValue.deployment === "object"
			? gcpValue.deployment
			: null
	const logsValue =
		gcpValue.logs && typeof gcpValue.logs === "object" ? gcpValue.logs : null
	const gcp = {
		account: optionalAgentText(gcpValue.account, 320),
		deployment: deploymentValue
			? {
					latestCreatedRevision: optionalAgentText(
						deploymentValue.latestCreatedRevision,
						160,
					),
					latestReadyRevision: optionalAgentText(
						deploymentValue.latestReadyRevision,
						160,
					),
					ready: deploymentValue.ready === true,
					status: cleanAgentStatus(deploymentValue.status, "pending"),
					traffic: (Array.isArray(deploymentValue.traffic)
						? deploymentValue.traffic
						: []
					)
						.slice(0, 10)
						.map(traffic => ({
							percent: Math.max(0, Math.min(100, Number(traffic.percent) || 0)),
							revisionName: optionalAgentText(traffic.revisionName, 160),
							tag: optionalAgentText(traffic.tag, 160),
						})),
				}
			: null,
		error: optionalAgentText(gcpValue.error, 500),
		logs: logsValue
			? {
					count: Math.max(0, Number(logsValue.count) || 0),
					entries: (Array.isArray(logsValue.entries) ? logsValue.entries : [])
						.slice(0, 20)
						.map(entry => ({
							message: optionalAgentText(entry.message, 400),
							severity: optionalAgentText(entry.severity, 40),
							timestamp: optionalAgentText(entry.timestamp, 40),
						})),
					filter: optionalAgentText(logsValue.filter, 2_048),
					status: cleanAgentStatus(logsValue.status),
					windowEnd: optionalAgentText(logsValue.windowEnd, 40),
					windowStart: optionalAgentText(logsValue.windowStart, 40),
				}
			: null,
		status: cleanAgentStatus(gcpValue.status, "not_configured"),
		target: gcpValue.target ? cleanGcpTarget(gcpValue.target) : null,
	}
	return {
		checkedAt,
		gcp,
		github,
		status: cleanAgentStatus(value.status),
	}
}

function cleanPullRequestAgent(value) {
	const agent = value && typeof value === "object" ? value : {}
	return {
		gcpTarget: cleanGcpTarget(agent.gcpTarget),
		lastCheck: cleanPrAgentSnapshot(agent.lastCheck),
		monitorRuns: cleanMonitorRuns(agent.monitorRuns),
		monitorSessionIds: [
			...new Set(
				(Array.isArray(agent.monitorSessionIds)
					? agent.monitorSessionIds
					: []
				).filter(value => typeof value === "string" && value.length <= 160),
			),
		].slice(0, MAX_LINKED_THREADS),
	}
}

function cleanPullRequests(value) {
	if (value == null) return []
	if (!Array.isArray(value)) {
		throw new TypeError("Pull requests must be a list")
	}
	const seenUrls = new Set()
	const pullRequests = []
	for (const candidate of value.slice(0, MAX_PULL_REQUESTS)) {
		if (!candidate || typeof candidate !== "object") continue
		if (typeof candidate.url !== "string" || candidate.url.length > 2_048) {
			throw new TypeError("Enter a valid pull request URL")
		}
		let url
		try {
			url = new URL(candidate.url.trim())
		} catch {
			throw new TypeError("Enter a valid pull request URL")
		}
		if (!["http:", "https:"].includes(url.protocol)) {
			throw new TypeError("Pull request URL must use HTTP or HTTPS")
		}
		const normalizedUrl = url.toString()
		if (seenUrls.has(normalizedUrl)) continue
		seenUrls.add(normalizedUrl)
		const createdAt =
			typeof candidate.createdAt === "string" &&
			Number.isFinite(new Date(candidate.createdAt).getTime())
				? candidate.createdAt
				: new Date().toISOString()
		const label =
			typeof candidate.label === "string" && candidate.label.trim()
				? cleanText(candidate.label, 160, "Pull request name")
				: defaultPullRequestLabel(url)
		pullRequests.push({
			agent: cleanPullRequestAgent(candidate.agent),
			createdAt,
			id:
				typeof candidate.id === "string" && candidate.id.length <= 160
					? candidate.id
					: randomUUID(),
			label,
			url: normalizedUrl,
		})
	}
	return pullRequests
}

function createWorkItem(title, now = new Date().toISOString()) {
	return {
		agent: "either",
		archivedAt: "",
		autoLinkForks: false,
		createdAt: now,
		id: randomUUID(),
		notes: "",
		priority: "medium",
		pendingLaunches: [],
		pullRequests: [],
		sessionIds: [],
		sessionNames: {},
		status: "planned",
		statusHistory: [
			{
				changedAt: now,
				from: "",
				source: "created",
				to: "planned",
				triggerId: "",
			},
		],
		title: cleanText(title, 160, "Task title"),
		updatedAt: now,
		workspacePath: "",
	}
}

function normalizeLoadedState(value) {
	if (!value || typeof value !== "object" || !Array.isArray(value.features)) {
		throw new TypeError("Planning file has an unsupported format")
	}
	for (const feature of value.features) {
		if (!Array.isArray(feature.workItems)) feature.workItems = []
		for (const item of feature.workItems) {
			if (!ALLOWED_AGENTS.has(item.agent)) item.agent = "either"
			item.archivedAt = cleanArchivedAt(item.archivedAt)
			item.autoLinkForks = item.autoLinkForks === true
			if (!ALLOWED_PRIORITIES.has(item.priority)) item.priority = "medium"
			item.pendingLaunches = cleanPendingLaunches(item.pendingLaunches)
			item.pullRequests = cleanPullRequests(item.pullRequests)
			item.sessionNames = cleanSessionNames(item.sessionNames)
			if (!ALLOWED_STATUSES.has(item.status)) item.status = "planned"
			item.statusHistory = cleanStatusHistory(item.statusHistory, item)
			item.workspacePath = cleanWorkspacePath(item.workspacePath)
		}
	}
	return { features: value.features, version: 1 }
}

class FilePlanningPersistence {
	#dataFile

	constructor(dataFile) {
		this.#dataFile = dataFile
	}

	async read() {
		try {
			return JSON.parse(await readFile(this.#dataFile, "utf8"))
		} catch (error) {
			if (error?.code === "ENOENT") return null
			throw error
		}
	}

	async write(state) {
		await mkdir(path.dirname(this.#dataFile), { mode: 0o700, recursive: true })
		const temporaryFile = `${this.#dataFile}.${process.pid}.tmp`
		await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, {
			mode: 0o600,
		})
		await rename(temporaryFile, this.#dataFile)
	}
}

export class PlanningStore {
	#persistence
	#pendingWrite = Promise.resolve()

	constructor(persistence) {
		this.#persistence =
			typeof persistence === "string"
				? new FilePlanningPersistence(persistence)
				: persistence
		if (
			!this.#persistence ||
			typeof this.#persistence.read !== "function" ||
			typeof this.#persistence.write !== "function"
		) {
			throw new TypeError("Planning persistence must provide read and write")
		}
	}

	async read() {
		const state = await this.#persistence.read()
		return state == null
			? { features: [], version: 1 }
			: normalizeLoadedState(state)
	}

	async #write(state) {
		await this.#persistence.write(state)
	}

	async close() {
		await this.#persistence.close?.()
	}

	update(mutator, { shouldWrite } = {}) {
		const operation = this.#pendingWrite.then(async () => {
			const state = await this.read()
			const result = await mutator(state)
			if (!shouldWrite || shouldWrite(result, state)) {
				await this.#write(state)
			}
			return { result, state }
		})
		this.#pendingWrite = operation.catch(() => undefined)
		return operation
	}

	createFeature(input) {
		return this.update(state => {
			const now = new Date().toISOString()
			const feature = {
				createdAt: now,
				description: cleanDescription(input.description),
				id: randomUUID(),
				title: cleanText(input.title, 120, "Feature title"),
				updatedAt: now,
				workItems: (Array.isArray(input.workItems) ? input.workItems : [])
					.map(value => (typeof value === "string" ? value.trim() : ""))
					.filter(Boolean)
					.slice(0, 50)
					.map(title => createWorkItem(title, now)),
			}
			state.features.unshift(feature)
			return feature
		})
	}

	updateFeature(featureId, input) {
		return this.update(state => {
			const feature = state.features.find(
				candidate => candidate.id === featureId,
			)
			if (!feature) return null
			if (Object.hasOwn(input, "title")) {
				feature.title = cleanText(input.title, 120, "Feature title")
			}
			if (Object.hasOwn(input, "description")) {
				feature.description = cleanDescription(input.description)
			}
			feature.updatedAt = new Date().toISOString()
			return feature
		})
	}

	deleteFeature(featureId) {
		return this.update(state => {
			const index = state.features.findIndex(
				feature => feature.id === featureId,
			)
			if (index < 0) return null
			return state.features.splice(index, 1)[0]
		})
	}

	addWorkItems(featureId, input) {
		return this.update(state => {
			const feature = state.features.find(
				candidate => candidate.id === featureId,
			)
			if (!feature) return null
			const titles = (Array.isArray(input.titles) ? input.titles : [])
				.map(value => (typeof value === "string" ? value.trim() : ""))
				.filter(Boolean)
				.slice(0, 50)
			if (titles.length === 0) {
				throw new TypeError("Add at least one task")
			}
			const now = new Date().toISOString()
			const items = titles.map(title => createWorkItem(title, now))
			feature.workItems.push(...items)
			feature.updatedAt = now
			return items
		})
	}

	updateWorkItem(featureId, itemId, input) {
		return this.update(state => {
			const feature = state.features.find(
				candidate => candidate.id === featureId,
			)
			const item = feature?.workItems.find(candidate => candidate.id === itemId)
			if (!feature || !item) return null
			const now = new Date().toISOString()

			if (Object.hasOwn(input, "autoLinkForks")) {
				if (typeof input.autoLinkForks !== "boolean") {
					throw new TypeError("Automatic fork linking must be true or false")
				}
				item.autoLinkForks = input.autoLinkForks
			}
			if (Object.hasOwn(input, "title")) {
				item.title = cleanText(input.title, 160, "Task title")
			}
			if (Object.hasOwn(input, "notes")) {
				item.notes = cleanDescription(input.notes)
			}
			if (Object.hasOwn(input, "status")) {
				if (!ALLOWED_STATUSES.has(input.status)) {
					throw new TypeError("Unsupported task status")
				}
				if (item.archivedAt && input.status !== "done") {
					throw new TypeError("Unarchive this task before changing its status")
				}
				if (item.status !== input.status) {
					addStatusHistory(item, {
						changedAt: now,
						from: item.status,
						source: "manual",
						to: input.status,
						triggerId: "",
					})
				}
				item.status = input.status
			}
			if (Object.hasOwn(input, "priority")) {
				if (!ALLOWED_PRIORITIES.has(input.priority)) {
					throw new TypeError("Unsupported task priority")
				}
				item.priority = input.priority
			}
			if (Object.hasOwn(input, "agent")) {
				if (!ALLOWED_AGENTS.has(input.agent)) {
					throw new TypeError("Unsupported agent")
				}
				item.agent = input.agent
			}
			if (Object.hasOwn(input, "workspacePath")) {
				item.workspacePath = cleanWorkspacePath(input.workspacePath)
			}
			if (Object.hasOwn(input, "sessionIds")) {
				if (!Array.isArray(input.sessionIds)) {
					throw new TypeError("Session identifiers must be a list")
				}
				item.sessionIds = [
					...new Set(
						input.sessionIds.filter(
							value => typeof value === "string" && value.length <= 160,
						),
					),
				].slice(0, MAX_LINKED_THREADS)
			}
			if (Object.hasOwn(input, "sessionNames")) {
				item.sessionNames = cleanSessionNames(input.sessionNames)
			}
			if (Object.hasOwn(input, "pullRequests")) {
				item.pullRequests = cleanPullRequests(input.pullRequests)
			}
			item.sessionNames = Object.fromEntries(
				Object.entries(item.sessionNames).filter(([sessionId]) =>
					item.sessionIds.includes(sessionId),
				),
			)
			for (const pullRequest of item.pullRequests) {
				pullRequest.agent.monitorSessionIds =
					pullRequest.agent.monitorSessionIds.filter(sessionId =>
						item.sessionIds.includes(sessionId),
					)
			}

			item.updatedAt = now
			feature.updatedAt = now
			return item
		})
	}

	setWorkItemArchived(featureId, itemId, archived, now = new Date()) {
		return this.update(state => {
			const feature = state.features.find(
				candidate => candidate.id === featureId,
			)
			const item = feature?.workItems.find(candidate => candidate.id === itemId)
			if (!feature || !item) return null
			if (typeof archived !== "boolean") {
				throw new TypeError("Task archive state must be true or false")
			}
			if (archived && item.status !== "done") {
				throw new TypeError("Only completed tasks can be archived")
			}
			const updatedAt = now.toISOString()
			item.archivedAt = archived ? updatedAt : ""
			item.updatedAt = updatedAt
			feature.updatedAt = updatedAt
			return item
		})
	}

	updatePullRequestAgent(featureId, itemId, pullRequestId, input) {
		return this.update(state => {
			const feature = state.features.find(
				candidate => candidate.id === featureId,
			)
			const item = feature?.workItems.find(candidate => candidate.id === itemId)
			const pullRequest = item?.pullRequests.find(
				candidate => candidate.id === pullRequestId,
			)
			if (!feature || !item || !pullRequest) return null
			pullRequest.agent = {
				gcpTarget: cleanGcpTarget(input.gcpTarget),
				lastCheck: cleanPrAgentSnapshot(input.lastCheck),
				monitorRuns: pullRequest.agent?.monitorRuns ?? [],
				monitorSessionIds: pullRequest.agent?.monitorSessionIds ?? [],
			}
			const now = new Date().toISOString()
			item.updatedAt = now
			feature.updatedAt = now
			return pullRequest
		})
	}

	recordPrMonitorRun(featureId, itemId, pullRequestId, input) {
		return this.update(state => {
			const feature = state.features.find(
				candidate => candidate.id === featureId,
			)
			const item = feature?.workItems.find(candidate => candidate.id === itemId)
			const pullRequest = item?.pullRequests.find(
				candidate => candidate.id === pullRequestId,
			)
			if (!feature || !item || !pullRequest) return null
			const now = new Date().toISOString()
			const runs = cleanMonitorRuns([
				...(pullRequest.agent?.monitorRuns ?? []),
				input,
			])
			pullRequest.agent.monitorRuns = runs
			item.workspacePath = cleanWorkspacePath(input.workspacePath)
			if (item.status === "planned") {
				addStatusHistory(item, {
					changedAt: now,
					from: "planned",
					source: "monitor_started",
					to: "in_progress",
					triggerId: input.id,
				})
				item.status = "in_progress"
			}
			item.updatedAt = now
			feature.updatedAt = now
			return runs.at(-1)
		})
	}

	completePrMonitorRun(featureId, itemId, pullRequestId, runId, input) {
		return this.update(state => {
			const feature = state.features.find(
				candidate => candidate.id === featureId,
			)
			const item = feature?.workItems.find(candidate => candidate.id === itemId)
			const pullRequest = item?.pullRequests.find(
				candidate => candidate.id === pullRequestId,
			)
			const run = pullRequest?.agent?.monitorRuns?.find(
				candidate => candidate.id === runId,
			)
			if (!feature || !item || !pullRequest || !run) return null
			Object.assign(run, {
				activity: input.activity ?? [],
				completedAt: input.completedAt,
				error: input.error || "",
				status: input.status,
				summary: input.summary || "",
				verifiedIssueCount: Array.isArray(input.verifiedIssues)
					? input.verifiedIssues.length
					: 0,
			})
			pullRequest.agent.monitorRuns = cleanMonitorRuns(
				pullRequest.agent.monitorRuns,
			)
			const now = new Date().toISOString()
			item.updatedAt = now
			feature.updatedAt = now
			return pullRequest.agent.monitorRuns.find(
				candidate => candidate.id === runId,
			)
		})
	}

	recordPrMonitorActivity(featureId, itemId, pullRequestId, runId, activity) {
		return this.update(state => {
			const feature = state.features.find(
				candidate => candidate.id === featureId,
			)
			const item = feature?.workItems.find(candidate => candidate.id === itemId)
			const pullRequest = item?.pullRequests.find(
				candidate => candidate.id === pullRequestId,
			)
			const run = pullRequest?.agent?.monitorRuns?.find(
				candidate => candidate.id === runId,
			)
			if (!feature || !item || !pullRequest || !run) return null
			run.activity = cleanMonitorActivity(activity)
			const now = new Date().toISOString()
			item.updatedAt = now
			feature.updatedAt = now
			return run.activity
		})
	}

	recordSessionLaunch(featureId, itemId, launch) {
		return this.update(state => {
			const feature = state.features.find(
				candidate => candidate.id === featureId,
			)
			const item = feature?.workItems.find(candidate => candidate.id === itemId)
			if (!feature || !item) return null
			if (!["codex", "claude"].includes(launch.provider)) {
				throw new TypeError("Unsupported agent")
			}

			const now = new Date().toISOString()
			item.pendingLaunches = cleanPendingLaunches([
				...item.pendingLaunches,
				launch,
			])
			item.workspacePath = cleanWorkspacePath(launch.workspacePath)
			if (item.status === "planned") {
				addStatusHistory(item, {
					changedAt: now,
					from: "planned",
					source: "session_started",
					to: "in_progress",
					triggerId: launch.id,
				})
				item.status = "in_progress"
			}
			item.updatedAt = now
			feature.updatedAt = now
			return item
		})
	}

	cancelSessionLaunch(featureId, itemId, launchId) {
		return this.update(state => {
			const feature = state.features.find(
				candidate => candidate.id === featureId,
			)
			const item = feature?.workItems.find(candidate => candidate.id === itemId)
			if (!feature || !item) return null
			const statusEntryIndex = item.statusHistory.findLastIndex(
				entry =>
					entry.source === "session_started" && entry.triggerId === launchId,
			)
			if (statusEntryIndex >= 0) {
				const [entry] = item.statusHistory.splice(statusEntryIndex, 1)
				if (item.status === entry.to) item.status = entry.from
			}
			item.pendingLaunches = item.pendingLaunches.filter(
				launch => launch.id !== launchId,
			)
			item.updatedAt = new Date().toISOString()
			feature.updatedAt = item.updatedAt
			return item
		})
	}

	reconcilePendingLaunches(sessions, now = new Date()) {
		return this.update(
			state => {
				let linked = 0
				let changed = false
				const updatedAt = now.toISOString()
				for (const feature of state.features) {
					let featureChanged = false
					for (const item of feature.workItems) {
						const remaining = []
						for (const launch of item.pendingLaunches) {
							const session = sessions.find(
								candidate =>
									candidate.provider === launch.provider &&
									((launch.sessionId &&
										candidate.sessionId === launch.sessionId) ||
										candidate.launchToken === launch.token),
							)
							if (session) {
								if (!item.sessionIds.includes(session.id)) {
									item.sessionIds = [...item.sessionIds, session.id].slice(
										0,
										MAX_LINKED_THREADS,
									)
									linked += 1
								}
								if (launch.sessionName && !item.sessionNames[session.id]) {
									item.sessionNames[session.id] = launch.sessionName
								}
								if (launch.pullRequestId) {
									const pullRequest = item.pullRequests.find(
										candidate => candidate.id === launch.pullRequestId,
									)
									if (
										pullRequest &&
										!pullRequest.agent.monitorSessionIds.includes(session.id)
									) {
										pullRequest.agent.monitorSessionIds = [
											...pullRequest.agent.monitorSessionIds,
											session.id,
										].slice(0, MAX_LINKED_THREADS)
									}
								}
								changed = true
								featureChanged = true
								continue
							}
							const startedAt = new Date(launch.startedAt).getTime()
							if (
								Number.isFinite(startedAt) &&
								now.getTime() - startedAt > PENDING_LAUNCH_TTL_MS
							) {
								changed = true
								featureChanged = true
								continue
							}
							remaining.push(launch)
						}
						if (remaining.length !== item.pendingLaunches.length) {
							item.pendingLaunches = remaining
							item.updatedAt = updatedAt
						}
					}
					if (featureChanged) feature.updatedAt = updatedAt
				}
				return { changed, linked }
			},
			{ shouldWrite: result => result.changed },
		)
	}

	reconcileRelatedSessions(sessions) {
		return this.update(
			state => {
				let added = 0
				const now = new Date().toISOString()
				for (const feature of state.features) {
					let featureChanged = false
					for (const item of feature.workItems) {
						if (!item.autoLinkForks || item.sessionIds.length === 0) continue
						const expandedIds = relatedSessionIds(
							item.sessionIds,
							sessions,
						).slice(0, MAX_LINKED_THREADS)
						const existingIds = new Set(item.sessionIds)
						const addedForItem = expandedIds.filter(id => !existingIds.has(id))
						if (addedForItem.length === 0) continue
						item.sessionIds = expandedIds
						item.updatedAt = now
						featureChanged = true
						added += addedForItem.length
					}
					if (featureChanged) feature.updatedAt = now
				}
				return { added, changed: added > 0 }
			},
			{ shouldWrite: result => result.changed },
		)
	}

	reconcileSessionPullRequests(sessions, now = new Date()) {
		return this.update(
			state => {
				let linked = 0
				const updatedAt = now.toISOString()
				const sessionsById = new Map(
					sessions.map(session => [session.id, session]),
				)
				for (const feature of state.features) {
					let featureChanged = false
					for (const item of feature.workItems) {
						let pullRequests = item.pullRequests
						for (const sessionId of item.sessionIds) {
							const session = sessionsById.get(sessionId)
							for (const url of session?.pullRequestUrls ?? []) {
								try {
									const merged = cleanPullRequests([
										...pullRequests,
										{ createdAt: updatedAt, url },
									])
									if (merged.length === pullRequests.length) continue
									pullRequests = merged
									linked += 1
									featureChanged = true
								} catch {
									// Ignore malformed session markers instead of breaking refresh.
								}
							}
						}
						if (pullRequests === item.pullRequests) continue
						item.pullRequests = pullRequests
						item.updatedAt = updatedAt
					}
					if (featureChanged) feature.updatedAt = updatedAt
				}
				return { changed: linked > 0, linked }
			},
			{ shouldWrite: result => result.changed },
		)
	}

	deleteWorkItem(featureId, itemId) {
		return this.update(state => {
			const feature = state.features.find(
				candidate => candidate.id === featureId,
			)
			if (!feature) return null
			const index = feature.workItems.findIndex(item => item.id === itemId)
			if (index < 0) return null
			feature.updatedAt = new Date().toISOString()
			return feature.workItems.splice(index, 1)[0]
		})
	}
}
