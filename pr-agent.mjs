import { spawn } from "node:child_process"

const GITHUB_DEADLINE_MS = 15_000
const GCLOUD_CONFIG_DEADLINE_MS = 5_000
const GCLOUD_READ_DEADLINE_MS = 20_000
const MAX_COMMAND_OUTPUT_BYTES = 1_000_000
const POST_DEPLOY_LOG_WINDOW_MS = 30 * 60 * 1000
const SUCCESSFUL_CHECK_STATES = new Set(["NEUTRAL", "SKIPPED", "SUCCESS"])
const FAILED_CHECK_STATES = new Set([
	"ACTION_REQUIRED",
	"CANCELLED",
	"ERROR",
	"FAILURE",
	"STALE",
	"STARTUP_FAILURE",
	"TIMED_OUT",
])

function commandError(message, cause) {
	const error = new Error(message, cause ? { cause } : undefined)
	error.userMessage = message
	return error
}

export function runLocalCommand(
	command,
	args,
	{ timeoutMs, environment = {} } = {},
) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env: {
				...process.env,
				GH_PROMPT_DISABLED: "1",
				NO_COLOR: "1",
				...environment,
			},
			stdio: ["ignore", "pipe", "pipe"],
		})
		let stdout = ""
		let stderr = ""
		let outputExceeded = false
		let timedOut = false

		const append = (current, chunk) => {
			const next = current + chunk
			if (Buffer.byteLength(next) > MAX_COMMAND_OUTPUT_BYTES) {
				outputExceeded = true
				child.kill("SIGTERM")
				return current
			}
			return next
		}
		child.stdout.on("data", chunk => {
			stdout = append(stdout, chunk.toString("utf8"))
		})
		child.stderr.on("data", chunk => {
			stderr = append(stderr, chunk.toString("utf8"))
		})

		const timer = setTimeout(() => {
			timedOut = true
			child.kill("SIGTERM")
		}, timeoutMs)
		timer.unref()

		child.once("error", error => {
			clearTimeout(timer)
			reject(
				commandError(
					`${command} is unavailable. Install it and sign in before checking this PR.`,
					error,
				),
			)
		})
		child.once("close", code => {
			clearTimeout(timer)
			if (timedOut) {
				reject(commandError(`${command} did not respond within the deadline.`))
				return
			}
			if (outputExceeded) {
				reject(commandError(`${command} returned too much data.`))
				return
			}
			if (code !== 0) {
				const detail = stderr.replace(/\s+/gu, " ").trim().slice(0, 400)
				reject(
					commandError(
						detail || `${command} exited with status ${code ?? "unknown"}.`,
					),
				)
				return
			}
			resolve({ stderr, stdout })
		})
	})
}

function checkName(check) {
	return check.name || check.context || check.workflowName || "Unnamed check"
}

function checkState(check) {
	return String(
		check.conclusion || check.state || check.status || "",
	).toUpperCase()
}

function summarizeGitHubChecks(value) {
	const checks = Array.isArray(value) ? value : []
	const summary = {
		failing: 0,
		failingNames: [],
		passing: 0,
		pending: 0,
		pendingNames: [],
		total: checks.length,
	}
	for (const check of checks) {
		const state = checkState(check)
		if (SUCCESSFUL_CHECK_STATES.has(state)) {
			summary.passing += 1
		} else if (FAILED_CHECK_STATES.has(state)) {
			summary.failing += 1
			if (summary.failingNames.length < 5) {
				summary.failingNames.push(checkName(check))
			}
		} else {
			summary.pending += 1
			if (summary.pendingNames.length < 5) {
				summary.pendingNames.push(checkName(check))
			}
		}
	}
	return summary
}

function githubStatus(pr, checks) {
	if (
		checks.failing > 0 ||
		["BLOCKED", "DIRTY"].includes(pr.mergeStateStatus)
	) {
		return "attention"
	}
	if (
		checks.pending > 0 ||
		["BEHIND", "UNSTABLE"].includes(pr.mergeStateStatus)
	) {
		return "pending"
	}
	return "ready"
}

async function checkGitHub(pullRequest, runCommand) {
	let url
	try {
		url = new URL(pullRequest.url)
	} catch {
		return {
			error: "The linked pull request URL is invalid.",
			status: "unavailable",
		}
	}
	if (url.hostname.toLocaleLowerCase() !== "github.com") {
		return {
			error: "PR agent checks currently support GitHub pull requests.",
			status: "unsupported",
		}
	}

	try {
		const { stdout } = await runCommand(
			"gh",
			[
				"pr",
				"view",
				url.toString(),
				"--json",
				"headRefName,headRefOid,isDraft,mergeStateStatus,mergedAt,number,reviewDecision,state,statusCheckRollup,title,url",
			],
			{ timeoutMs: GITHUB_DEADLINE_MS },
		)
		const pr = JSON.parse(stdout)
		const checks = summarizeGitHubChecks(pr.statusCheckRollup)
		return {
			checks,
			headRefName: String(pr.headRefName || ""),
			headRefOid: String(pr.headRefOid || ""),
			isDraft: pr.isDraft === true,
			mergeStateStatus: String(pr.mergeStateStatus || "UNKNOWN"),
			mergedAt: typeof pr.mergedAt === "string" ? pr.mergedAt : "",
			number: Number(pr.number) || 0,
			reviewDecision: String(pr.reviewDecision || ""),
			state: String(pr.state || "UNKNOWN"),
			status: githubStatus(pr, checks),
			title: String(pr.title || pullRequest.label).slice(0, 200),
			url: String(pr.url || pullRequest.url),
		}
	} catch (error) {
		// Degrade: GitHub status is optional enrichment, so the linked PR stays
		// visible and the failed check remains explicitly retryable.
		return {
			error: error.userMessage || "GitHub status is unavailable.",
			status: "unavailable",
		}
	}
}

function logMessage(entry) {
	const message =
		entry.textPayload ||
		entry.jsonPayload?.message ||
		entry.protoPayload?.status?.message ||
		"Structured log entry"
	return String(message).replace(/\s+/gu, " ").trim().slice(0, 400)
}

function logFilter({
	project,
	region,
	revision,
	service,
	windowEnd,
	windowStart,
}) {
	return [
		'resource.type="cloud_run_revision"',
		`resource.labels.project_id="${project}"`,
		`resource.labels.location="${region}"`,
		`resource.labels.service_name="${service}"`,
		`resource.labels.revision_name="${revision}"`,
		"severity>=ERROR",
		`timestamp>="${windowStart}"`,
		`timestamp<="${windowEnd}"`,
	].join(" AND ")
}

async function checkGcp(target, runCommand, now) {
	if (!target?.project || !target?.region || !target?.service) {
		return { status: "not_configured" }
	}

	try {
		const { stdout: configOutput } = await runCommand(
			"gcloud",
			["config", "list", "--format=json(core.account,core.project)"],
			{ timeoutMs: GCLOUD_CONFIG_DEADLINE_MS },
		)
		const config = JSON.parse(configOutput)
		const account = String(config.core?.account || "")
		const activeProject = String(config.core?.project || "")
		if (!account) {
			throw commandError("Sign in to gcloud before checking deployment logs.")
		}
		if (activeProject !== target.project) {
			throw commandError(
				`The active gcloud project is ${activeProject || "not set"}. Switch it to ${target.project} before checking this deployment.`,
			)
		}

		const { stdout: serviceOutput } = await runCommand(
			"gcloud",
			[
				"run",
				"services",
				"describe",
				target.service,
				`--project=${target.project}`,
				`--region=${target.region}`,
				"--format=json",
				"--quiet",
			],
			{ timeoutMs: GCLOUD_READ_DEADLINE_MS },
		)
		const service = JSON.parse(serviceOutput)
		const readyCondition = (service.status?.conditions ?? []).find(
			condition => condition.type === "Ready",
		)
		const revision = String(service.status?.latestReadyRevisionName || "")
		const latestCreatedRevision = String(
			service.status?.latestCreatedRevisionName || "",
		)
		const ready =
			readyCondition?.status === "True" &&
			Boolean(revision) &&
			(!latestCreatedRevision || latestCreatedRevision === revision)
		const deployment = {
			latestCreatedRevision,
			latestReadyRevision: revision,
			ready,
			status: ready ? "ready" : "pending",
			traffic: (service.status?.traffic ?? []).slice(0, 10).map(target => ({
				percent: Number(target.percent) || 0,
				revisionName: String(target.revisionName || ""),
				tag: String(target.tag || ""),
			})),
		}
		if (!ready) {
			return { account, deployment, status: "pending", target }
		}

		const windowEnd = now.toISOString()
		const windowStart = new Date(
			now.getTime() - POST_DEPLOY_LOG_WINDOW_MS,
		).toISOString()
		const filter = logFilter({
			...target,
			revision,
			windowEnd,
			windowStart,
		})
		const { stdout: logOutput } = await runCommand(
			"gcloud",
			[
				"logging",
				"read",
				filter,
				`--project=${target.project}`,
				"--limit=20",
				"--order=desc",
				"--format=json",
				"--quiet",
			],
			{ timeoutMs: GCLOUD_READ_DEADLINE_MS },
		)
		const logEntries = JSON.parse(logOutput)
		const entries = (Array.isArray(logEntries) ? logEntries : [])
			.slice(0, 20)
			.map(entry => ({
				message: logMessage(entry),
				severity: String(entry.severity || "ERROR"),
				timestamp: String(entry.timestamp || ""),
			}))
		const logs = {
			count: entries.length,
			entries,
			filter,
			status: entries.length > 0 ? "attention" : "healthy",
			windowEnd,
			windowStart,
		}
		return {
			account,
			deployment,
			logs,
			status: entries.length > 0 ? "attention" : deployment.status,
			target,
		}
	} catch (error) {
		// Degrade: GCP status and logs are optional enrichment, so the GitHub
		// result and previously saved deployment snapshot remain usable.
		return {
			error: error.userMessage || "GCP deployment status is unavailable.",
			status: "unavailable",
			target,
		}
	}
}

function combinedStatus(github, gcp) {
	if ([github.status, gcp.status].includes("attention")) return "attention"
	if ([github.status, gcp.status].includes("pending")) return "pending"
	if (
		[github.status, gcp.status].some(status =>
			["unavailable", "unsupported"].includes(status),
		)
	) {
		return "unavailable"
	}
	return "healthy"
}

function validateGcpTarget(value) {
	if (value == null) return null
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("GCP target must be a project, region, and service")
	}
	const target = Object.fromEntries(
		["project", "region", "service"].map(field => [
			field,
			typeof value[field] === "string" ? value[field].trim() : "",
		]),
	)
	if (!target.project && !target.region && !target.service) return null
	if (!target.project || !target.region || !target.service) {
		throw new TypeError("Enter the GCP project, region, and Cloud Run service")
	}
	for (const [field, identifier] of Object.entries(target)) {
		if (identifier.length > 63 || !/^[a-z0-9][a-z0-9-]*$/u.test(identifier)) {
			throw new TypeError(`GCP ${field} contains unsupported characters`)
		}
	}
	return target
}

export async function inspectPullRequest({
	gcpTarget,
	now = new Date(),
	pullRequest,
	runCommand = runLocalCommand,
}) {
	const target = validateGcpTarget(gcpTarget)
	const [github, gcp] = await Promise.all([
		checkGitHub(pullRequest, runCommand),
		checkGcp(target, runCommand, now),
	])
	return {
		checkedAt: now.toISOString(),
		gcp,
		github,
		status: combinedStatus(github, gcp),
	}
}

export const internals = {
	checkGcp,
	checkGitHub,
	logFilter,
	runLocalCommand,
	summarizeGitHubChecks,
	validateGcpTarget,
}
