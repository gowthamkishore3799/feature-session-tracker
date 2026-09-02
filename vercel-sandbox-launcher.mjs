import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { promisify } from "node:util"
import { Sandbox } from "@vercel/sandbox"
import { getAuth as getStoredVercelAuth } from "@vercel/sandbox/dist/auth/index.js"
import { runLocalCommand } from "./pr-agent.mjs"

const execFileAsync = promisify(execFile)
const SANDBOX_ROOT = "/vercel/sandbox"
const CODEX_PACKAGE_VERSION = "0.147.0"
const DEFAULT_SANDBOX_TIMEOUT_MS = 30 * 60 * 1_000
const MIN_SANDBOX_TIMEOUT_MS = 5 * 60 * 1_000
const MAX_SANDBOX_TIMEOUT_MS = 24 * 60 * 60 * 1_000
const AUTH_PLACEHOLDER = "feature-tracker-brokered"
const SANDBOX_REQUEST_TIMEOUT_MS = 30_000
const MAX_MONITOR_ACTIVITY_ENTRIES = 80
const MAX_MONITOR_ACTIVITY_TEXT = 40_000
const ANSI_ESCAPE_PATTERN = new RegExp(
	`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`,
	"gu",
)
const LOCAL_ENV_FILE = path.resolve(import.meta.dirname, ".env.local")
const LEGACY_MONO_REVIEWER_ENV_FILE = path.resolve(
	import.meta.dirname,
	"../mono/pr-reviewer-saas/.env.local",
)

function configurationError(message, cause) {
	const error = new Error(message, cause ? { cause } : undefined)
	error.userMessage = message
	return error
}

function redactMonitorActivityText(value, maximumLength = 2_000) {
	return String(value ?? "")
		.replace(ANSI_ESCAPE_PATTERN, "")
		.replace(
			/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|ya29\.[A-Za-z0-9._-]+)\b/gu,
			"[redacted]",
		)
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu, "$1 [redacted]")
		.replace(
			/\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)(["']?\s*[:=]\s*["']?)([^\s"',}]+)/giu,
			"$1$2[redacted]",
		)
		.replace(/([?&](?:token|key|secret|signature)=)[^&#\s]+/giu, "$1[redacted]")
		.trim()
		.slice(0, maximumLength)
}

export function parseCodexMonitorActivity(eventsSource, stderrSource = "") {
	const activity = []
	const seen = new Set()
	let textBudget = MAX_MONITOR_ACTIVITY_TEXT
	let lastAgentUpdate = -1
	function add(kind, title, detail = "") {
		if (activity.length >= MAX_MONITOR_ACTIVITY_ENTRIES || textBudget <= 0)
			return
		const safeTitle = redactMonitorActivityText(title, 160)
		const safeDetail = redactMonitorActivityText(
			detail,
			Math.min(2_000, textBudget),
		)
		if (!safeTitle || (!safeDetail && kind === "message")) return
		const fingerprint = `${kind}:${safeTitle}:${safeDetail}`
		if (seen.has(fingerprint)) return
		seen.add(fingerprint)
		textBudget -= safeTitle.length + safeDetail.length
		activity.push({ detail: safeDetail, kind, title: safeTitle })
	}

	for (const line of String(eventsSource ?? "").split(/\r?\n/u)) {
		if (!line.trim()) continue
		let event
		try {
			event = JSON.parse(line)
		} catch {
			continue
		}
		const item = event?.item && typeof event.item === "object" ? event.item : {}
		if (event.type === "thread.started") {
			add("status", "Sandbox session started")
		} else if (event.type === "turn.started") {
			add("status", "Codex started monitoring")
		} else if (event.type === "turn.completed") {
			add("status", "Monitor pass finished")
		} else if (event.type === "error" || item.type === "error") {
			add("error", "Codex reported an error", event.message || item.message)
		} else if (
			event.type === "item.started" &&
			item.type === "command_execution"
		) {
			add("command", "Running command", item.command)
		} else if (
			event.type === "item.completed" &&
			item.type === "command_execution"
		) {
			const exitCode = Number.isInteger(item.exit_code)
				? `Exit status ${item.exit_code}`
				: item.status
					? `Status: ${item.status}`
					: ""
			add(
				item.exit_code === 0 ? "command" : "error",
				item.exit_code === 0 ? "Command finished" : "Command failed",
				[item.command, exitCode].filter(Boolean).join("\n"),
			)
		} else if (event.type === "item.completed" && item.type === "reasoning") {
			add("progress", "Progress summary", item.text || item.summary)
		} else if (
			event.type === "item.completed" &&
			item.type === "agent_message"
		) {
			add("message", "Agent update", item.text)
			lastAgentUpdate = activity.length - 1
		}
	}

	for (const line of String(stderrSource ?? "")
		.split(/\r?\n/u)
		.slice(-12)) {
		if (line.trim()) add("error", "Execution detail", line)
	}
	if (
		lastAgentUpdate >= 0 &&
		activity[lastAgentUpdate]?.title === "Agent update"
	) {
		activity[lastAgentUpdate] = {
			...activity[lastAgentUpdate],
			kind: "result",
			title: "Agent result",
		}
	}
	return activity
}

function requiredSecret(value, message) {
	const normalized = typeof value === "string" ? value.trim() : ""
	if (!normalized) throw configurationError(message)
	return normalized
}

function sandboxTimeout(environment) {
	const configured = Number(environment.FEATURE_TRACKER_SANDBOX_TIMEOUT_MS)
	if (!Number.isFinite(configured)) return DEFAULT_SANDBOX_TIMEOUT_MS
	return Math.max(
		MIN_SANDBOX_TIMEOUT_MS,
		Math.min(MAX_SANDBOX_TIMEOUT_MS, Math.round(configured)),
	)
}

export function resolveVercelCredentials(
	environment = process.env,
	storedAuth = getStoredVercelAuth,
) {
	if (environment.VERCEL_OIDC_TOKEN?.trim()) return {}
	const token = environment.VERCEL_TOKEN?.trim()
	const teamId = environment.VERCEL_TEAM_ID?.trim()
	const projectId = environment.VERCEL_PROJECT_ID?.trim()
	if (token || teamId || projectId) {
		if (!token || !teamId || !projectId) {
			throw configurationError(
				"Vercel Sandbox needs VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID together.",
			)
		}
		return { projectId, teamId, token }
	}
	if (storedAuth()?.token) return {}
	throw configurationError(
		"Connect this Mac to Vercel first with `pnpm feature-sessions:vercel-auth`, then retry the monitor.",
	)
}

function splitKeyPool(value) {
	return typeof value === "string"
		? value
				.split(",")
				.map(key => key.trim())
				.filter(Boolean)
		: []
}

function unquoteEnvValue(value) {
	const trimmed = value.trim()
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1)
	}
	return trimmed
}

export function parseReviewerOpenAiApiKeys(source) {
	const values = new Map()
	for (const line of source.split(/\r?\n/u)) {
		const match = line.match(
			/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u,
		)
		if (!match || match[2].trim().startsWith("#")) continue
		values.set(match[1], unquoteEnvValue(match[2]))
	}
	return [
		...splitKeyPool(values.get("OPENAI_API_KEYS")),
		...splitKeyPool(values.get("OPENAI_API_KEY")),
		...splitKeyPool(values.get("BETA_FEATURES_OPENAI_API_KEY")),
	]
}

function environmentOpenAiApiKeys(environment) {
	const explicitKey = environment.FEATURE_TRACKER_CODEX_API_KEY?.trim()
	if (explicitKey) return [explicitKey]
	return [
		...splitKeyPool(environment.CODEX_API_KEY),
		...splitKeyPool(environment.OPENAI_API_KEYS),
		...splitKeyPool(environment.OPENAI_API_KEY),
		...splitKeyPool(environment.BETA_FEATURES_OPENAI_API_KEY),
	]
}

export function selectCodexApiKey(keys, seed = "feature-tracker") {
	const uniqueKeys = [...new Set(keys.filter(Boolean))]
	if (uniqueKeys.length === 0) {
		throw configurationError(
			"Add a direct OpenAI API key to .env.local or the tracker process environment. The key is brokered by Vercel and is never written inside the sandbox.",
		)
	}
	let hash = 0
	for (const character of seed) {
		hash = (Math.imul(hash, 31) + character.codePointAt(0)) >>> 0
	}
	return uniqueKeys[hash % uniqueKeys.length]
}

export function resolveCodexApiKey(environment = process.env) {
	return selectCodexApiKey(environmentOpenAiApiKeys(environment))
}

export async function resolveCodexApiKeyForLaunch({
	environment = process.env,
	envLocalPath = environment.FEATURE_TRACKER_OPENAI_ENV_FILE,
	launchId,
}) {
	const environmentKeys = environmentOpenAiApiKeys(environment)
	let reviewerKeys = []
	const candidateFiles = envLocalPath
		? [path.resolve(envLocalPath)]
		: [LOCAL_ENV_FILE, LEGACY_MONO_REVIEWER_ENV_FILE]
	for (const candidateFile of candidateFiles) {
		try {
			reviewerKeys.push(
				...parseReviewerOpenAiApiKeys(await readFile(candidateFile, "utf8")),
			)
		} catch (error) {
			if (error?.code !== "ENOENT") throw error
		}
	}
	return selectCodexApiKey([...environmentKeys, ...reviewerKeys], launchId)
}

export function parseGitHubPullRequest(value) {
	let url
	try {
		url = new URL(value)
	} catch (cause) {
		throw configurationError("The linked pull request URL is invalid.", cause)
	}
	const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/u)
	if (url.hostname.toLowerCase() !== "github.com" || !match) {
		throw configurationError(
			"Vercel Sandbox monitoring currently supports GitHub.com pull requests.",
		)
	}
	return {
		name: decodeURIComponent(match[2]),
		number: Number(match[3]),
		owner: decodeURIComponent(match[1]),
		url: url.toString(),
	}
}

export async function resolveMonitorBrokerCredentials({
	gcpTarget,
	pullRequest,
	runCommand = runLocalCommand,
}) {
	parseGitHubPullRequest(pullRequest.url)
	const { stdout: githubOutput } = await runCommand(
		"gh",
		["auth", "token", "--hostname", "github.com"],
		{ timeoutMs: 5_000 },
	)
	const githubToken = requiredSecret(
		githubOutput,
		"Sign in to GitHub CLI before starting a sandbox monitor.",
	)

	if (!gcpTarget?.project || !gcpTarget.region || !gcpTarget.service) {
		return { githubToken }
	}

	const { stdout: configOutput } = await runCommand(
		"gcloud",
		["config", "list", "--format=json(core.account,core.project)"],
		{ timeoutMs: 5_000 },
	)
	const config = JSON.parse(configOutput)
	const account = String(config.core?.account || "").trim()
	const activeProject = String(config.core?.project || "").trim()
	if (!account) {
		throw configurationError(
			"Sign in to gcloud before starting a deployment monitor.",
		)
	}
	if (activeProject !== gcpTarget.project) {
		throw configurationError(
			`The active gcloud project is ${activeProject || "not set"}. Switch it to ${gcpTarget.project} before starting this monitor.`,
		)
	}
	const { stdout: gcpOutput } = await runCommand(
		"gcloud",
		["auth", "print-access-token", `--account=${account}`, "--quiet"],
		{ timeoutMs: 10_000 },
	)
	return {
		gcpAccessToken: requiredSecret(
			gcpOutput,
			"gcloud could not issue a short-lived access token for this monitor.",
		),
		githubToken,
	}
}

export function buildSandboxNetworkPolicy({
	gcpAccessToken,
	githubToken,
	openAiApiKey,
}) {
	const allow = {
		"api.github.com": [
			{
				transform: [{ headers: { authorization: `Bearer ${githubToken}` } }],
			},
		],
		"api.openai.com": [
			{
				transform: [{ headers: { authorization: `Bearer ${openAiApiKey}` } }],
			},
		],
		"registry.npmjs.org": [],
	}
	if (gcpAccessToken) {
		for (const domain of ["logging.googleapis.com", "run.googleapis.com"]) {
			allow[domain] = [
				{
					transform: [
						{ headers: { authorization: `Bearer ${gcpAccessToken}` } },
					],
				},
			]
		}
	}
	return {
		allow,
		subnets: {
			deny: [
				"0.0.0.0/8",
				"10.0.0.0/8",
				"100.64.0.0/10",
				"127.0.0.0/8",
				"169.254.0.0/16",
				"172.16.0.0/12",
				"192.168.0.0/16",
			],
		},
	}
}

export function buildMonitorContext({ gcpTarget, launchId, pullRequest }) {
	return {
		gcpTarget: gcpTarget?.project ? { ...gcpTarget } : null,
		launchId,
		pullRequest: parseGitHubPullRequest(pullRequest.url),
	}
}

export function buildMonitorApiScript() {
	return `import { readFile } from "node:fs/promises"

const context = JSON.parse(await readFile("${SANDBOX_ROOT}/monitor-context.json", "utf8"))
const authHeaders = { authorization: "Bearer ${AUTH_PLACEHOLDER}" }

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...authHeaders, "content-type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(\`Monitor API returned HTTP \${response.status}: \${text.slice(0, 300)}\`)
  return JSON.parse(text)
}

function requireTarget() {
  if (!context.gcpTarget) throw new Error("No Cloud Run target is configured for this PR")
  return context.gcpTarget
}

async function github() {
  const query = \`query MonitorPullRequest($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        title url state isDraft mergeStateStatus reviewDecision headRefName headRefOid mergedAt
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
          ... on CheckRun { name status conclusion }
          ... on StatusContext { context state }
        } } } } } }
      }
    }
  }\`
  return request("https://api.github.com/graphql", {
    method: "POST",
    body: JSON.stringify({ query, variables: context.pullRequest }),
  })
}

async function cloudRun() {
  const target = requireTarget()
  const path = ["projects", target.project, "locations", target.region, "services", target.service]
    .map(encodeURIComponent).join("/")
  return request(\`https://run.googleapis.com/v2/\${path}\`)
}

async function logs(revision) {
  const target = requireTarget()
  if (!revision || !revision.startsWith(\`\${target.service}-\`)) throw new Error("Revision does not belong to the configured service")
  const windowEnd = new Date()
  const windowStart = new Date(windowEnd.getTime() - 30 * 60 * 1000)
  const quote = value => String(value).replaceAll("\\\\", "\\\\\\\\").replaceAll('"', '\\"')
  const filter = [
    'resource.type="cloud_run_revision"',
    \`resource.labels.project_id="\${quote(target.project)}"\`,
    \`resource.labels.location="\${quote(target.region)}"\`,
    \`resource.labels.service_name="\${quote(target.service)}"\`,
    \`resource.labels.revision_name="\${quote(revision)}"\`,
    "severity>=ERROR",
    \`timestamp>="\${windowStart.toISOString()}"\`,
    \`timestamp<="\${windowEnd.toISOString()}"\`,
  ].join(" AND ")
  const result = await request("https://logging.googleapis.com/v2/entries:list", {
    method: "POST",
    body: JSON.stringify({
      resourceNames: [\`projects/\${target.project}\`],
      filter,
      orderBy: "timestamp desc",
      pageSize: 20,
    }),
  })
  return {
    entries: (result.entries || []).slice(0, 20).map(entry => ({
      timestamp: entry.timestamp || "",
      severity: entry.severity || "ERROR",
      message: String(entry.textPayload || entry.jsonPayload?.message || entry.protoPayload?.status?.message || "Structured log entry")
        .replace(/\\s+/gu, " ").slice(0, 400),
    })),
    filter,
    windowEnd: windowEnd.toISOString(),
    windowStart: windowStart.toISOString(),
  }
}

const [command, argument] = process.argv.slice(2)
const result = command === "github" ? await github()
  : command === "cloud-run" ? await cloudRun()
  : command === "logs" ? await logs(argument)
  : (() => { throw new Error("Use github, cloud-run, or logs <revision>") })()
process.stdout.write(JSON.stringify(result, null, 2) + "\\n")
`
}

export function buildMonitorResultSchema() {
	return {
		additionalProperties: false,
		properties: {
			status: {
				enum: ["healthy", "pending", "issue", "blocked"],
				type: "string",
			},
			summary: { maxLength: 1_000, minLength: 1, type: "string" },
			verifiedIssues: {
				items: {
					additionalProperties: false,
					properties: {
						message: { maxLength: 500, minLength: 1, type: "string" },
						severity: {
							enum: ["warning", "error"],
							type: "string",
						},
						title: { maxLength: 120, minLength: 1, type: "string" },
					},
					required: ["title", "message", "severity"],
					type: "object",
				},
				maxItems: 5,
				type: "array",
			},
		},
		required: ["status", "summary", "verifiedIssues"],
		type: "object",
	}
}

export function buildCodexMonitorCommand() {
	return [
		"set -u",
		`cd ${SANDBOX_ROOT}`,
		`export CODEX_HOME=${SANDBOX_ROOT}/.codex`,
		`export npm_config_cache=${SANDBOX_ROOT}/.npm-cache`,
		'mkdir -p "$CODEX_HOME" "$npm_config_cache"',
		`npx --yes @openai/codex@${CODEX_PACKAGE_VERSION} exec --ignore-user-config --skip-git-repo-check --sandbox read-only --json --output-schema ${SANDBOX_ROOT}/result-schema.json --output-last-message ${SANDBOX_ROOT}/result.json - < ${SANDBOX_ROOT}/prompt.md > ${SANDBOX_ROOT}/events.jsonl 2> ${SANDBOX_ROOT}/stderr.log`,
		"exit_code=$?",
		`printf '{"exitCode":%s}\\n' "$exit_code" > ${SANDBOX_ROOT}/command-result.json`,
		'exit "$exit_code"',
	].join("\n")
}

function publicRun(startedAt, sandbox, command, timeoutMs) {
	return {
		commandId: command.cmdId,
		expiresAt:
			sandbox.expiresAt instanceof Date
				? sandbox.expiresAt.toISOString()
				: new Date(Date.now() + timeoutMs).toISOString(),
		provider: "vercel",
		sandboxId: sandbox.sandboxId || sandbox.name,
		startedAt,
		status: "running",
	}
}

function cleanMonitorResult(value) {
	if (!value || typeof value !== "object") {
		throw new TypeError("Codex did not return a monitor result")
	}
	const statuses = new Set(["healthy", "pending", "issue", "blocked"])
	const status = statuses.has(value.status) ? value.status : "blocked"
	const summary = String(value.summary || "Codex monitor completed.")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, 1_000)
	const verifiedIssues = (
		Array.isArray(value.verifiedIssues) ? value.verifiedIssues : []
	)
		.slice(0, 5)
		.map(issue => ({
			message: String(issue?.message || "")
				.replace(/\s+/gu, " ")
				.trim()
				.slice(0, 500),
			severity: issue?.severity === "error" ? "error" : "warning",
			title: String(issue?.title || "PR monitor issue")
				.replace(/\s+/gu, " ")
				.trim()
				.slice(0, 120),
		}))
		.filter(issue => issue.message && issue.title)
	return { status, summary, verifiedIssues }
}

async function readSandboxJson(sandbox, fileName, signal) {
	const content = await sandbox.readFileToBuffer(
		{ path: `${SANDBOX_ROOT}/${fileName}` },
		{ signal },
	)
	if (!content) throw new Error(`${fileName} was not created`)
	return JSON.parse(content.toString("utf8"))
}

async function readSandboxText(sandbox, fileName, signal) {
	try {
		const content = await sandbox.readFileToBuffer(
			{ path: `${SANDBOX_ROOT}/${fileName}` },
			{ signal },
		)
		return content?.toString("utf8") ?? ""
	} catch {
		return ""
	}
}

async function readSandboxActivity(sandbox, signal) {
	const [eventsSource, stderrSource] = await Promise.all([
		readSandboxText(sandbox, "events.jsonl", signal),
		readSandboxText(sandbox, "stderr.log", signal),
	])
	return parseCodexMonitorActivity(eventsSource, stderrSource)
}

async function waitForCompletion(
	sandbox,
	command,
	timeoutMs = DEFAULT_SANDBOX_TIMEOUT_MS,
) {
	let activity = []
	try {
		const signal = AbortSignal.timeout(timeoutMs + 60_000)
		const result = await command.wait({ signal })
		activity = await readSandboxActivity(sandbox, signal)
		if (result.exitCode !== 0) {
			return {
				activity,
				completedAt: new Date().toISOString(),
				error: `Codex exited with status ${result.exitCode}.`,
				status: "failed",
				verifiedIssues: [],
			}
		}
		const monitorResult = cleanMonitorResult(
			await readSandboxJson(sandbox, "result.json", signal),
		)
		return {
			activity,
			completedAt: new Date().toISOString(),
			...monitorResult,
		}
	} catch (error) {
		activity = await readSandboxActivity(
			sandbox,
			AbortSignal.timeout(SANDBOX_REQUEST_TIMEOUT_MS),
		)
		return {
			activity,
			completedAt: new Date().toISOString(),
			error: String(error?.message || "Unable to read the Codex result").slice(
				0,
				500,
			),
			status: "failed",
			verifiedIssues: [],
		}
	}
}

export async function readPrMonitorSandboxActivity({
	environment = process.env,
	run,
	sandboxClass = Sandbox,
	vercelCredentials,
}) {
	if (!run?.sandboxId) {
		throw configurationError(
			"This monitor run has no Vercel Sandbox identifier.",
		)
	}
	try {
		const sandbox = await sandboxClass.get({
			...(vercelCredentials ?? resolveVercelCredentials(environment)),
			name: run.sandboxId,
			signal: AbortSignal.timeout(SANDBOX_REQUEST_TIMEOUT_MS),
		})
		return {
			activity: await readSandboxActivity(
				sandbox,
				AbortSignal.timeout(SANDBOX_REQUEST_TIMEOUT_MS),
			),
			available: true,
		}
	} catch (cause) {
		throw configurationError(
			"This sandbox is no longer available. New monitor runs retain their activity after the sandbox expires.",
			cause,
		)
	}
}

async function stopSandboxAfterLaunchFailure(sandbox) {
	if (!sandbox) return
	try {
		await sandbox.stop({ signal: AbortSignal.timeout(5_000) })
	} catch {
		// The original launch failure is more useful than a best-effort cleanup error.
	}
}

export async function launchPrMonitorSandbox({
	environment = process.env,
	gcpTarget,
	launchId,
	prompt,
	pullRequest,
	resolveBrokerCredentials = resolveMonitorBrokerCredentials,
	sandboxClass = Sandbox,
	vercelCredentials,
}) {
	const openAiApiKey = await resolveCodexApiKeyForLaunch({
		environment,
		launchId,
	})
	const brokerCredentials = await resolveBrokerCredentials({
		gcpTarget,
		pullRequest,
	})
	const timeoutMs = sandboxTimeout(environment)
	const startedAt = new Date().toISOString()
	let sandbox
	let stage = "create"
	try {
		sandbox = await sandboxClass.create({
			...(vercelCredentials ?? resolveVercelCredentials(environment)),
			networkPolicy: buildSandboxNetworkPolicy({
				...brokerCredentials,
				openAiApiKey,
			}),
			persistent: true,
			resources: { vcpus: 2 },
			runtime: "node24",
			signal: AbortSignal.timeout(SANDBOX_REQUEST_TIMEOUT_MS),
			tags: { app: "feature-tracker", launch: launchId.slice(0, 64) },
			timeout: timeoutMs,
		})
		stage = "stage"
		await sandbox.writeFiles(
			[
				{
					content: JSON.stringify(
						buildMonitorContext({ gcpTarget, launchId, pullRequest }),
						null,
						2,
					),
					path: `${SANDBOX_ROOT}/monitor-context.json`,
				},
				{
					content: buildMonitorApiScript(),
					path: `${SANDBOX_ROOT}/monitor-api.mjs`,
				},
				{ content: prompt, path: `${SANDBOX_ROOT}/prompt.md` },
				{
					content: JSON.stringify(buildMonitorResultSchema(), null, 2),
					path: `${SANDBOX_ROOT}/result-schema.json`,
				},
			],
			{ signal: AbortSignal.timeout(SANDBOX_REQUEST_TIMEOUT_MS) },
		)
		stage = "command"
		const command = await sandbox.runCommand({
			args: ["-lc", buildCodexMonitorCommand()],
			cmd: "/bin/bash",
			cwd: SANDBOX_ROOT,
			detached: true,
			env: {
				CODEX_API_KEY: AUTH_PLACEHOLDER,
				NO_COLOR: "1",
			},
			signal: AbortSignal.timeout(SANDBOX_REQUEST_TIMEOUT_MS),
		})
		return {
			completion: waitForCompletion(sandbox, command, timeoutMs),
			run: publicRun(startedAt, sandbox, command, timeoutMs),
		}
	} catch (error) {
		await stopSandboxAfterLaunchFailure(sandbox)
		if (error?.userMessage) throw error
		const stageMessages = {
			command:
				"Vercel created the sandbox, but could not start Codex. Please retry.",
			create: "Vercel could not create the monitor sandbox. Please retry.",
			stage:
				"Vercel created the sandbox, but the tracker could not stage its monitor files. Please retry.",
		}
		throw configurationError(stageMessages[stage], error)
	}
}

export async function resumePrMonitorSandboxRun({
	environment = process.env,
	run,
	sandboxClass = Sandbox,
	vercelCredentials,
}) {
	try {
		const sandbox = await sandboxClass.get({
			...(vercelCredentials ?? resolveVercelCredentials(environment)),
			name: run.sandboxId,
			signal: AbortSignal.timeout(SANDBOX_REQUEST_TIMEOUT_MS),
		})
		const command = await sandbox.getCommand(run.commandId, {
			signal: AbortSignal.timeout(SANDBOX_REQUEST_TIMEOUT_MS),
		})
		const expiresAt = new Date(run.expiresAt).getTime()
		const remainingMs = Number.isFinite(expiresAt)
			? Math.max(60_000, expiresAt - Date.now())
			: DEFAULT_SANDBOX_TIMEOUT_MS
		return { completion: waitForCompletion(sandbox, command, remainingMs) }
	} catch (error) {
		return {
			completion: Promise.resolve({
				completedAt: new Date().toISOString(),
				error: String(
					error?.message || "Unable to reconnect to the Vercel Sandbox run.",
				).slice(0, 500),
				status: "failed",
				verifiedIssues: [],
			}),
		}
	}
}

export async function notifyVerifiedIssues(
	issues,
	{ exec = execFileAsync, homeDirectory = process.env.HOME } = {},
) {
	const script = `${homeDirectory}/.codex/skills/notify-iphone/scripts/notify.py`
	for (const issue of issues.slice(0, 5)) {
		await exec(
			"python3",
			[
				script,
				"--title",
				issue.title,
				"--message",
				issue.message,
				"--priority",
				"high",
				"--tag",
				issue.severity === "error" ? "rotating_light" : "warning",
			],
			{ timeout: 15_000 },
		)
	}
}

export const internals = {
	AUTH_PLACEHOLDER,
	CODEX_PACKAGE_VERSION,
	cleanMonitorResult,
	configurationError,
	readSandboxJson,
	sandboxTimeout,
	waitForCompletion,
}
