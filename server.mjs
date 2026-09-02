#!/usr/bin/env node

import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { readFile, stat } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { PlanningStore } from "./planning-store.mjs"
import { PostgresPlanningPersistence } from "./postgres-persistence.mjs"
import { inspectPullRequest } from "./pr-agent.mjs"
import { setCodexSessionArchived } from "./session-lifecycle.mjs"
import {
	launchAgentSession,
	launchCodexForkSession,
} from "./session-launcher.mjs"
import { scanAgentSessions } from "./session-index.mjs"
import {
	launchPrMonitorSandbox,
	notifyVerifiedIssues,
	readPrMonitorSandboxActivity,
	resumePrMonitorSandboxRun,
} from "./vercel-sandbox-launcher.mjs"

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const publicDirectory = path.join(scriptDirectory, "public")
const DEFAULT_DATABASE_URL =
	"postgresql://feature_session_tracker:feature_session_tracker_local@127.0.0.1:55432/feature_session_tracker"
const MAX_BODY_BYTES = 1_000_000
const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "localhost"])
const STATIC_FILES = new Map([
	["/", ["index.html", "text/html; charset=utf-8"]],
	["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
	["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
	["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
])

function writeHeaders(response, status, contentType) {
	response.writeHead(status, {
		"Cache-Control": "no-store",
		"Content-Security-Policy":
			"default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
		"Content-Type": contentType,
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
	})
}

function sendJson(response, status, value) {
	writeHeaders(response, status, "application/json; charset=utf-8")
	response.end(`${JSON.stringify(value)}\n`)
}

function localMutationAllowed(request) {
	if (request.headers["x-feature-tracker"] !== "1") return false
	const origin = request.headers.origin
	if (!origin) return true
	try {
		return LOCAL_HOSTS.has(new URL(origin).hostname)
	} catch {
		return false
	}
}

async function readJsonBody(request) {
	let body = ""
	for await (const chunk of request) {
		body += chunk
		if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
			throw new RangeError("Request is too large")
		}
	}
	if (!body.trim()) return {}
	return JSON.parse(body)
}

function routeParts(pathname) {
	return pathname
		.split("/")
		.filter(Boolean)
		.map(part => decodeURIComponent(part))
}

function launchContext(value) {
	if (value == null || value === "") return ""
	if (typeof value !== "string") {
		throw new TypeError("Session instructions must be text")
	}
	const normalized = value.trim()
	if (normalized.length > 4_000) {
		throw new TypeError("Session instructions must be 4000 characters or less")
	}
	return normalized
}

function buildSessionPrompt(feature, item, context, launchId) {
	return [
		`Task: ${item.title}`,
		`Feature: ${feature.title}`,
		feature.description ? `Outcome: ${feature.description}` : "",
		context || item.notes ? `Task notes: ${context || item.notes}` : "",
		"Work on this task in the current repository. Keep the changes focused on this task and report progress before you finish.",
		"If you create or open a pull request, include one machine-readable line per pull request in your final response using this exact format: <!-- feature-tracker-pr:FULL_HTTPS_PULL_REQUEST_URL -->. The tracker will attach each reported pull request to this task.",
		`<!-- feature-tracker-launch:${launchId} -->`,
	]
		.filter(Boolean)
		.join("\n\n")
}

function buildCodexForkPrompt(feature, item, launchId) {
	return [
		`Forked task: ${item.title}`,
		`Feature: ${feature.title}`,
		"Review the inherited thread context and wait for the user's follow-up instructions before changing files.",
		"If you create or open a pull request later, include one machine-readable line per pull request in your final response using this exact format: <!-- feature-tracker-pr:FULL_HTTPS_PULL_REQUEST_URL -->.",
		`<!-- feature-tracker-launch:${launchId} -->`,
	].join("\n\n")
}

export function buildPrMonitorPrompt(
	feature,
	item,
	pullRequest,
	instructions,
	launchId,
) {
	const target = pullRequest.agent?.gcpTarget
	const github = pullRequest.agent?.lastCheck?.github
	const gcp = pullRequest.agent?.lastCheck?.gcp
	const objective = target
		? `Monitor ${pullRequest.url} until its newest deployment to Cloud Run service ${target.service} in ${target.project}/${target.region} is ready and its post-deploy ERROR logs are healthy, or until a verified actionable issue requires the user's attention.`
		: `Assess ${pullRequest.url} for verified GitHub issues and explain that continuous deployment and log monitoring requires a Cloud Run target in the feature tracker.`
	return [
		"PR monitor requested by the user. You are running as a noninteractive Codex CLI job inside an isolated, tracker-owned Vercel Sandbox.",
		`Feature: ${feature.title}`,
		`Task: ${item.title}`,
		`Pull request: ${pullRequest.label} (${pullRequest.url})`,
		github
			? `Saved GitHub snapshot: ${github.state || "unknown"}; ${github.checks?.passing ?? 0} passing, ${github.checks?.pending ?? 0} pending, ${github.checks?.failing ?? 0} failing checks.`
			: "Saved GitHub snapshot: none.",
		target
			? `Cloud Run target: project ${target.project}, region ${target.region}, service ${target.service}. Saved deployment state: ${gcp?.status || "not checked"}.`
			: "Cloud Run target: not configured.",
		instructions ? `User instructions:\n${instructions}` : "",
		`Monitor objective: ${objective}`,
		"The feature tracker owns the durable run record. Do not call create_goal; that desktop tool is unavailable in noninteractive Codex. Return the required structured final result instead.",
		"Use `node /vercel/sandbox/monitor-api.mjs github` exactly once for the GitHub assessment. It uses one bounded GraphQL request with host-brokered credentials.",
		target
			? "Use `node /vercel/sandbox/monitor-api.mjs cloud-run` once. If and only if the newest created revision is ready, use `node /vercel/sandbox/monitor-api.mjs logs <revision>` once for a 30-minute, 20-entry ERROR-or-higher query against that exact revision."
			: "No Cloud Run target is configured, so do not attempt a GCP request.",
		"Only put newly verified actionable issues in verifiedIssues. Never include credentials, raw logs, stack traces, or source code in the final summary or issue messages. The tracker invokes the local notify-iphone skill after validating this structured result; do not contact notification services from the sandbox.",
		"This is read-only monitoring. Do not merge, approve, comment on, close, rerun, or otherwise mutate the pull request, deployment, or cloud resources.",
		"Perform exactly one bounded GitHub status read. Do not poll GitHub. If GitHub is not ready, report verified actionable failures and use the configured Cloud Run target—not repeated GitHub reads—to assess deployment progress.",
		target
			? "For deployment monitoring, compare the Cloud Run v2 latestCreatedRevision and latestReadyRevision values. Only after the newest revision is ready, query ERROR-or-higher logs for that exact revision with explicit project, region, service, timestamps, descending order, and a limit. Mark the run healthy only after the deployment and its post-deploy log window are healthy."
			: "Because no Cloud Run target is configured, complete after the bounded GitHub assessment and clearly state that deployment logs were not monitored.",
		`<!-- feature-tracker-launch:${launchId} -->`,
	]
		.filter(Boolean)
		.join("\n\n")
}

async function usableWorkspace(value) {
	if (typeof value !== "string" || !value.trim()) {
		throw new TypeError("Choose a workspace folder")
	}
	const workspacePath = path.normalize(value.trim())
	if (!path.isAbsolute(workspacePath)) {
		throw new TypeError("Workspace folder must be an absolute path")
	}
	if (workspacePath.length > 4_096) {
		throw new TypeError("Workspace folder must be 4096 characters or less")
	}
	let workspaceStats
	try {
		workspaceStats = await stat(workspacePath)
	} catch {
		throw new TypeError("Workspace folder does not exist")
	}
	if (!workspaceStats.isDirectory()) {
		throw new TypeError("Workspace folder must be a directory")
	}
	return workspacePath
}

export function createTrackerServer({
	dataFile = path.join(os.homedir(), ".feature-session-tracker", "state.json"),
	defaultWorkspace = process.cwd(),
	homeDirectory = os.homedir(),
	inspectPr = inspectPullRequest,
	launchFork = launchCodexForkSession,
	launchSession = launchAgentSession,
	launchMonitor = launchPrMonitorSandbox,
	notifyIssues = notifyVerifiedIssues,
	planningStore,
	readMonitorActivity = readPrMonitorSandboxActivity,
	resumeMonitor = resumePrMonitorSandboxRun,
	scanSessions = scanAgentSessions,
	setSessionArchived = setCodexSessionArchived,
} = {}) {
	const store = planningStore ?? new PlanningStore(dataFile)
	let sessionSnapshot = null
	let sessionSnapshotExpiresAt = 0
	let sessionScan = null
	const prAgentChecks = new Map()
	const monitorWatchers = new Map()

	function monitorRunKey(featureId, itemId, pullRequestId, runId) {
		return `${featureId}:${itemId}:${pullRequestId}:${runId}`
	}

	function watchMonitorCompletion({
		completion,
		featureId,
		itemId,
		pullRequestId,
		runId,
	}) {
		const key = monitorRunKey(featureId, itemId, pullRequestId, runId)
		if (monitorWatchers.has(key)) return
		const watcher = Promise.resolve(completion)
			.then(async result => {
				await store.completePrMonitorRun(
					featureId,
					itemId,
					pullRequestId,
					runId,
					result,
				)
				if (result.status === "issue" && result.verifiedIssues?.length) {
					await notifyIssues(result.verifiedIssues)
				}
			})
			.catch(error => {
				process.stderr.write(
					`Vercel PR monitor completion failed: ${String(error?.message || error)}\n`,
				)
			})
			.finally(() => monitorWatchers.delete(key))
		monitorWatchers.set(key, watcher)
	}

	function reconnectStoredMonitorRuns(state) {
		const runs = []
		for (const feature of state.features) {
			for (const item of feature.workItems) {
				for (const pullRequest of item.pullRequests ?? []) {
					for (const run of pullRequest.agent?.monitorRuns ?? []) {
						if (run.status === "running") {
							runs.push({
								featureId: feature.id,
								itemId: item.id,
								pullRequestId: pullRequest.id,
								run,
							})
						}
					}
				}
			}
		}
		for (const candidate of runs
			.sort((left, right) =>
				right.run.startedAt.localeCompare(left.run.startedAt),
			)
			.slice(0, 8)) {
			const key = monitorRunKey(
				candidate.featureId,
				candidate.itemId,
				candidate.pullRequestId,
				candidate.run.id,
			)
			if (monitorWatchers.has(key)) continue
			const completion = Promise.resolve()
				.then(() => resumeMonitor({ run: candidate.run }))
				.then(result => result.completion)
			watchMonitorCompletion({
				completion,
				featureId: candidate.featureId,
				itemId: candidate.itemId,
				pullRequestId: candidate.pullRequestId,
				runId: candidate.run.id,
			})
		}
	}

	async function getSessions(force = false) {
		if (!force && sessionSnapshot && Date.now() < sessionSnapshotExpiresAt) {
			return sessionSnapshot
		}
		if (!sessionScan) {
			sessionScan = scanSessions({ homeDirectory })
				.then(sessions => {
					sessionSnapshot = sessions
					sessionSnapshotExpiresAt = Date.now() + 5_000
					return sessions
				})
				.finally(() => {
					sessionScan = null
				})
		}
		return sessionScan
	}

	async function setItemArchiveState(featureId, itemId, archived) {
		const state = await store.read()
		const feature = state.features.find(candidate => candidate.id === featureId)
		const item = feature?.workItems.find(candidate => candidate.id === itemId)
		if (!feature || !item) return null
		if (archived && item.status !== "done") {
			throw new TypeError("Only completed tasks can be archived")
		}

		const sessions = await getSessions(true)
		const sessionsById = new Map(sessions.map(session => [session.id, session]))
		const targets = item.sessionIds
			.filter(sessionId => sessionId.startsWith("codex:"))
			.map(sessionId => sessionsById.get(sessionId))
			.filter(Boolean)
		const unavailableCodexSessions = item.sessionIds.filter(
			sessionId =>
				sessionId.startsWith("codex:") && !sessionsById.has(sessionId),
		).length
		const transitions = targets.filter(session => session.archived !== archived)
		const completed = []

		try {
			for (const session of transitions) {
				await setSessionArchived({ archived, sessionId: session.sessionId })
				completed.push(session)
			}
		} catch (error) {
			for (const session of completed.reverse()) {
				await setSessionArchived({
					archived: !archived,
					sessionId: session.sessionId,
				}).catch(() => undefined)
			}
			throw error
		}

		let operation
		try {
			operation = await store.setWorkItemArchived(featureId, itemId, archived)
		} catch (error) {
			for (const session of completed.reverse()) {
				await setSessionArchived({
					archived: !archived,
					sessionId: session.sessionId,
				}).catch(() => undefined)
			}
			throw error
		}
		sessionSnapshot = null
		sessionSnapshotExpiresAt = 0
		return {
			codexSessionsChanged: completed.length,
			operation,
			unavailableCodexSessions,
		}
	}

	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? "/", "http://127.0.0.1")
			if (request.method === "GET" && STATIC_FILES.has(url.pathname)) {
				const [fileName, contentType] = STATIC_FILES.get(url.pathname)
				writeHeaders(response, 200, contentType)
				response.end(await readFile(path.join(publicDirectory, fileName)))
				return
			}

			if (request.method === "GET" && url.pathname === "/api/bootstrap") {
				const sessions = await getSessions(
					url.searchParams.get("refresh") === "1",
				)
				const launched = await store.reconcilePendingLaunches(sessions)
				const reconciliation = await store.reconcileRelatedSessions(sessions)
				const pullRequests = await store.reconcileSessionPullRequests(sessions)
				reconnectStoredMonitorRuns(pullRequests.state)
				sendJson(response, 200, {
					autoLinkedCount: reconciliation.result.added,
					defaultWorkspace,
					features: pullRequests.state.features,
					launchedLinkedCount: launched.result.linked,
					pullRequestsLinkedCount: pullRequests.result.linked,
					scannedAt: new Date().toISOString(),
					sessions,
				})
				return
			}

			if (!["GET", "HEAD"].includes(request.method ?? "")) {
				if (!localMutationAllowed(request)) {
					sendJson(response, 403, {
						error: "Local mutation header is required",
					})
					return
				}
			}

			const parts = routeParts(url.pathname)
			if (parts[0] !== "api" || parts[1] !== "features") {
				sendJson(response, 404, { error: "Not found" })
				return
			}
			const input = await readJsonBody(request)
			let operation

			if (
				request.method === "POST" &&
				parts.length === 10 &&
				parts[3] === "items" &&
				parts[5] === "pull-requests" &&
				parts[7] === "monitor-runs" &&
				parts[9] === "activity"
			) {
				const state = await store.read()
				const feature = state.features.find(
					candidate => candidate.id === parts[2],
				)
				const item = feature?.workItems.find(
					candidate => candidate.id === parts[4],
				)
				const pullRequest = item?.pullRequests.find(
					candidate => candidate.id === parts[6],
				)
				const run = pullRequest?.agent?.monitorRuns?.find(
					candidate => candidate.id === parts[8],
				)
				if (!run) {
					sendJson(response, 404, { error: "Monitor run not found" })
					return
				}
				const result =
					run.activity?.length && run.status !== "running"
						? { activity: run.activity, available: true, retained: true }
						: await readMonitorActivity({ run })
				if (result.activity?.length) {
					await store.recordPrMonitorActivity(
						feature.id,
						item.id,
						pullRequest.id,
						run.id,
						result.activity,
					)
					result.retained = true
				}
				sendJson(response, 200, result)
				return
			} else if (
				request.method === "POST" &&
				parts.length === 8 &&
				parts[3] === "items" &&
				parts[5] === "sessions" &&
				parts[7] === "fork"
			) {
				const state = await store.read()
				const feature = state.features.find(
					candidate => candidate.id === parts[2],
				)
				const item = feature?.workItems.find(
					candidate => candidate.id === parts[4],
				)
				const linkedSessionId = parts[6]
				if (
					!feature ||
					!item ||
					!linkedSessionId.startsWith("codex:") ||
					!item.sessionIds.includes(linkedSessionId)
				) {
					sendJson(response, 404, { error: "Linked Codex session not found" })
					return
				}
				const sessions = await getSessions()
				const session = sessions.find(
					candidate => candidate.id === linkedSessionId,
				)
				const workspacePath = await usableWorkspace(
					input.workspacePath ||
						item.workspacePath ||
						session?.cwd ||
						defaultWorkspace,
				)
				const launchId = randomUUID()
				const startedAt = new Date().toISOString()
				operation = await store.recordSessionLaunch(parts[2], parts[4], {
					id: launchId,
					provider: "codex",
					sessionName: `${item.title} fork`,
					startedAt,
					token: launchId,
					workspacePath,
				})
				try {
					await launchFork({
						prompt: buildCodexForkPrompt(feature, item, launchId),
						sessionId: linkedSessionId.slice("codex:".length),
						workspacePath,
					})
				} catch (error) {
					await store.cancelSessionLaunch(parts[2], parts[4], launchId)
					throw error
				}
				sendJson(response, 200, {
					features: operation.state.features,
					result: { launchId, provider: "codex", workspacePath },
				})
				return
			} else if (
				request.method === "POST" &&
				parts.length === 6 &&
				parts[3] === "items" &&
				["archive", "unarchive"].includes(parts[5])
			) {
				const archived = parts[5] === "archive"
				const archivedResult = await setItemArchiveState(
					parts[2],
					parts[4],
					archived,
				)
				if (!archivedResult) {
					sendJson(response, 404, { error: "Feature or task not found" })
					return
				}
				sendJson(response, 200, {
					features: archivedResult.operation.state.features,
					result: {
						codexSessionsChanged: archivedResult.codexSessionsChanged,
						item: archivedResult.operation.result,
						unavailableCodexSessions: archivedResult.unavailableCodexSessions,
					},
				})
				return
			} else if (
				request.method === "POST" &&
				parts.length === 8 &&
				parts[3] === "items" &&
				parts[5] === "pull-requests" &&
				parts[7] === "monitor"
			) {
				const state = await store.read()
				const feature = state.features.find(
					candidate => candidate.id === parts[2],
				)
				const item = feature?.workItems.find(
					candidate => candidate.id === parts[4],
				)
				const pullRequest = item?.pullRequests.find(
					candidate => candidate.id === parts[6],
				)
				if (!feature || !item || !pullRequest) {
					sendJson(response, 404, { error: "Pull request not found" })
					return
				}
				const workspacePath = await usableWorkspace(
					input.workspacePath || item.workspacePath || defaultWorkspace,
				)
				const instructions = launchContext(input.instructions)
				const launchId = randomUUID()
				const startedAt = new Date().toISOString()
				const launched = await launchMonitor({
					gcpTarget: pullRequest.agent?.gcpTarget,
					launchId,
					prompt: buildPrMonitorPrompt(
						feature,
						item,
						pullRequest,
						instructions,
						launchId,
					),
					pullRequest,
					taskTitle: `Monitor ${pullRequest.label}`.slice(0, 100),
					workspacePath,
				})
				operation = await store.recordPrMonitorRun(
					feature.id,
					item.id,
					pullRequest.id,
					{
						...launched.run,
						id: launchId,
						startedAt: launched.run.startedAt || startedAt,
						workspacePath,
					},
				)
				watchMonitorCompletion({
					completion: launched.completion,
					featureId: feature.id,
					itemId: item.id,
					pullRequestId: pullRequest.id,
					runId: launchId,
				})
				sendJson(response, 200, {
					features: operation.state.features,
					result: {
						...launched.run,
						launchId,
						provider: "vercel",
						pullRequestId: pullRequest.id,
						workspacePath,
					},
				})
				return
			} else if (
				request.method === "POST" &&
				parts.length === 8 &&
				parts[3] === "items" &&
				parts[5] === "pull-requests" &&
				parts[7] === "check"
			) {
				const state = await store.read()
				const feature = state.features.find(
					candidate => candidate.id === parts[2],
				)
				const item = feature?.workItems.find(
					candidate => candidate.id === parts[4],
				)
				const pullRequest = item?.pullRequests.find(
					candidate => candidate.id === parts[6],
				)
				if (!feature || !item || !pullRequest) {
					sendJson(response, 404, { error: "Pull request not found" })
					return
				}
				const checkKey = `${feature.id}:${item.id}:${pullRequest.id}`
				let check = prAgentChecks.get(checkKey)
				if (!check) {
					check = inspectPr({
						gcpTarget: input.gcpTarget,
						pullRequest,
					}).finally(() => prAgentChecks.delete(checkKey))
					prAgentChecks.set(checkKey, check)
				}
				const lastCheck = await check
				operation = await store.updatePullRequestAgent(
					feature.id,
					item.id,
					pullRequest.id,
					{ gcpTarget: input.gcpTarget, lastCheck },
				)
			} else if (
				request.method === "POST" &&
				parts.length === 6 &&
				parts[3] === "items" &&
				parts[5] === "launch"
			) {
				if (!["codex", "claude"].includes(input.provider)) {
					throw new TypeError("Choose Codex or Claude Code")
				}
				const state = await store.read()
				const feature = state.features.find(
					candidate => candidate.id === parts[2],
				)
				const item = feature?.workItems.find(
					candidate => candidate.id === parts[4],
				)
				if (!feature || !item) {
					sendJson(response, 404, { error: "Feature or task not found" })
					return
				}
				const workspacePath = await usableWorkspace(
					input.workspacePath || item.workspacePath || defaultWorkspace,
				)
				const context = launchContext(input.context)
				const launchId = randomUUID()
				const sessionId = input.provider === "claude" ? randomUUID() : ""
				const startedAt = new Date().toISOString()
				operation = await store.recordSessionLaunch(parts[2], parts[4], {
					id: launchId,
					provider: input.provider,
					sessionId,
					startedAt,
					token: launchId,
					workspacePath,
				})
				let launchResult
				try {
					launchResult = await launchSession({
						prompt: buildSessionPrompt(feature, item, context, launchId),
						provider: input.provider,
						sessionId,
						taskTitle: item.title,
						workspacePath,
					})
				} catch (error) {
					await store.cancelSessionLaunch(parts[2], parts[4], launchId)
					throw error
				}
				sendJson(response, 200, {
					features: operation.state.features,
					result: {
						launchId,
						provider: input.provider,
						threadId: launchResult?.threadId ?? null,
						workspacePath,
					},
				})
				return
			} else if (request.method === "POST" && parts.length === 2) {
				operation = await store.createFeature(input)
			} else if (request.method === "PATCH" && parts.length === 3) {
				operation = await store.updateFeature(parts[2], input)
			} else if (request.method === "DELETE" && parts.length === 3) {
				operation = await store.deleteFeature(parts[2])
			} else if (
				request.method === "POST" &&
				parts.length === 4 &&
				parts[3] === "items"
			) {
				operation = await store.addWorkItems(parts[2], input)
			} else if (
				request.method === "PATCH" &&
				parts.length === 5 &&
				parts[3] === "items"
			) {
				operation = await store.updateWorkItem(parts[2], parts[4], input)
			} else if (
				request.method === "DELETE" &&
				parts.length === 5 &&
				parts[3] === "items"
			) {
				operation = await store.deleteWorkItem(parts[2], parts[4])
			} else {
				sendJson(response, 404, { error: "Not found" })
				return
			}

			if (operation.result == null) {
				sendJson(response, 404, { error: "Feature or task not found" })
				return
			}
			sendJson(response, 200, {
				features: operation.state.features,
				result: operation.result,
			})
		} catch (error) {
			const isInputError =
				error instanceof TypeError ||
				error instanceof RangeError ||
				error instanceof SyntaxError
			sendJson(response, isInputError ? 400 : 500, {
				error: isInputError
					? error.message
					: error.userMessage ||
						"The local tracker could not complete this request",
			})
		}
	})

	return server
}

function readOption(name, fallback) {
	const index = process.argv.indexOf(name)
	if (index < 0) return fallback
	return process.argv[index + 1] ?? fallback
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const portValue = Number(readOption("--port", "4737"))
	if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65_535) {
		process.stderr.write("Port must be an integer between 1 and 65535.\n")
		process.exit(2)
	}
	const dataFile = readOption(
		"--data-file",
		path.join(os.homedir(), ".feature-session-tracker", "state.json"),
	)
	const storage = readOption("--storage", "postgres")
	if (!["file", "postgres"].includes(storage)) {
		process.stderr.write("Storage must be postgres or file.\n")
		process.exit(2)
	}
	const databaseUrl = readOption(
		"--database-url",
		process.env.FEATURE_TRACKER_DATABASE_URL || DEFAULT_DATABASE_URL,
	)
	const persistence =
		storage === "postgres"
			? new PostgresPlanningPersistence({
					connectionString: databaseUrl,
					legacyDataFile: dataFile,
				})
			: dataFile
	const planningStore = new PlanningStore(persistence)
	try {
		await planningStore.read()
	} catch (error) {
		process.stderr.write(
			`${error.userMessage || "The tracker database could not be opened"}\n`,
		)
		process.exit(1)
	}
	const server = createTrackerServer({ dataFile, planningStore })
	server.on("close", () => {
		void planningStore.close()
	})
	server.listen(portValue, "127.0.0.1", () => {
		process.stdout.write(
			`Feature tracker is ready at http://127.0.0.1:${portValue} using ${storage} storage\n`,
		)
	})
}
