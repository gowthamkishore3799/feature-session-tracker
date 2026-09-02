import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import {
	mkdtemp,
	mkdir,
	readFile,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { PassThrough, Writable } from "node:stream"
import { afterEach, test } from "node:test"
import {
	buildCodexThreadUrl,
	launchCodexAppSession,
} from "../codex-app-launcher.mjs"
import { PlanningStore } from "../planning-store.mjs"
import { PostgresPlanningPersistence } from "../postgres-persistence.mjs"
import { inspectPullRequest } from "../pr-agent.mjs"
import { buildPrMonitorPrompt, createTrackerServer } from "../server.mjs"
import { setCodexSessionArchived } from "../session-lifecycle.mjs"
import {
	buildCodexForkCommand,
	buildLaunchCommand,
	buildTerminalScript,
} from "../session-launcher.mjs"
import { relatedSessionIds, scanAgentSessions } from "../session-index.mjs"
import {
	buildCodexMonitorCommand,
	buildMonitorApiScript,
	buildMonitorContext,
	buildSandboxNetworkPolicy,
	launchPrMonitorSandbox,
	parseCodexMonitorActivity,
	parseGitHubPullRequest,
	parseReviewerOpenAiApiKeys,
	resolveCodexApiKey,
	resolveCodexApiKeyForLaunch,
	selectCodexApiKey,
} from "../vercel-sandbox-launcher.mjs"

const temporaryDirectories = []

async function temporaryDirectory() {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), "feature-tracker-test-"),
	)
	temporaryDirectories.push(directory)
	return directory
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory =>
			rm(directory, {
				force: true,
				recursive: true,
			}),
		),
	)
})

test("normalizes Codex and Claude Code sessions without returning transcripts", async () => {
	const homeDirectory = await temporaryDirectory()
	const codexDirectory = path.join(
		homeDirectory,
		".codex",
		"sessions",
		"2026",
		"08",
		"31",
	)
	const claudeDirectory = path.join(
		homeDirectory,
		".claude",
		"projects",
		"-work-project",
	)
	const codexArchiveDirectory = path.join(
		homeDirectory,
		".codex",
		"archived_sessions",
	)
	await Promise.all([
		mkdir(codexDirectory, { recursive: true }),
		mkdir(codexArchiveDirectory, { recursive: true }),
		mkdir(claudeDirectory, { recursive: true }),
	])
	const codexIndex = new DatabaseSync(
		path.join(homeDirectory, ".codex", "state_5.sqlite"),
	)
	codexIndex.exec(
		"CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, name TEXT)",
	)
	codexIndex
		.prepare("INSERT INTO threads (id, title, name) VALUES (?, ?, ?)")
		.run("codex-session", "Follow up PR", null)
	codexIndex.close()
	const codexFile = path.join(codexDirectory, "rollout-codex-session.jsonl")
	const archivedCodexFile = path.join(
		codexArchiveDirectory,
		"rollout-codex-session-copy.jsonl",
	)
	const claudeFile = path.join(claudeDirectory, "claude-session.jsonl")
	await writeFile(
		codexFile,
		[
			JSON.stringify({
				payload: {
					cwd: "/work/project",
					forked_from_id: "codex-parent",
					git: { branch: "feature/codex" },
					id: "codex-session",
					timestamp: "2026-08-31T10:00:00.000Z",
					thread_source: "user",
				},
				timestamp: "2026-08-31T10:00:00.000Z",
				type: "session_meta",
			}),
			"{partially-written",
			JSON.stringify({
				payload: {
					forked_from_id: "older-parent",
					id: "copied-parent-session",
					thread_source: "user",
				},
				type: "session_meta",
			}),
			JSON.stringify({
				payload: {
					message:
						"Build the session dashboard with a private token ABC-123\n<!-- feature-tracker-launch:11111111-1111-4111-8111-111111111111 -->",
					type: "user_message",
				},
				type: "event_msg",
			}),
			...Array.from({ length: 250 }, (_, index) =>
				JSON.stringify({
					payload: { index, type: "agent_reasoning" },
					type: "event_msg",
				}),
			),
			JSON.stringify({
				payload: {
					message:
						"Opened the implementation PR.\n<!-- feature-tracker-pr:https://github.com/coderabbitai/mono/pull/571 -->",
					type: "agent_message",
				},
				type: "event_msg",
			}),
			JSON.stringify({
				payload: {
					call_id: "create-pr-call",
					input:
						"await tools.exec_command({ cmd: \"set -e\\ngh pr create --title 'Automatic PR'\" })",
					name: "exec",
					type: "custom_tool_call",
				},
				type: "response_item",
			}),
			JSON.stringify({
				payload: {
					call_id: "create-pr-call",
					output: [
						{
							text: "https://github.com/coderabbitai/mono/pull/573",
							type: "input_text",
						},
					],
					type: "custom_tool_call_output",
				},
				type: "response_item",
			}),
			JSON.stringify({
				payload: {
					call_id: "search-call",
					input: `await tools.exec_command({ cmd: "rg -n 'gh pr create' ." })`,
					name: "exec",
					type: "custom_tool_call",
				},
				type: "response_item",
			}),
			JSON.stringify({
				payload: {
					call_id: "search-call",
					output: [
						{
							text: "Unrelated https://github.com/coderabbitai/mono/pull/9999",
							type: "input_text",
						},
					],
					type: "custom_tool_call_output",
				},
				type: "response_item",
			}),
		].join("\n"),
	)
	await writeFile(
		archivedCodexFile,
		JSON.stringify({
			payload: {
				cwd: "/old/worktree",
				id: "codex-session",
				timestamp: "2026-08-30T10:00:00.000Z",
			},
			type: "session_meta",
		}),
	)
	await writeFile(
		path.join(homeDirectory, ".codex", "session_index.jsonl"),
		[
			JSON.stringify({
				id: "codex-session",
				thread_name: "Older generated title",
				updated_at: "2026-08-31T09:59:00.000Z",
			}),
			"{partially-written",
			JSON.stringify({
				id: "codex-session",
				thread_name: "Investigate REV-571 rendering issue",
				updated_at: "2026-08-31T10:01:00.000Z",
			}),
		].join("\n"),
	)
	await writeFile(
		claudeFile,
		[
			JSON.stringify({
				aiTitle: "Plan the import flow",
				sessionId: "claude-session",
				type: "ai-title",
			}),
			JSON.stringify({
				cwd: "/work/project",
				gitBranch: "feature/claude",
				message: { content: "Full Claude transcript content", role: "user" },
				parentUuid: null,
				sessionId: "claude-session",
				timestamp: "2026-08-31T10:01:00.000Z",
				type: "user",
				uuid: "claude-root-message",
			}),
			JSON.stringify({
				customTitle: "Claude import flow",
				sessionId: "claude-session",
				type: "custom-title",
			}),
			JSON.stringify({
				message: {
					content: [
						{
							text: "Created two merge requests. <!-- feature-tracker-pr:https://gitlab.com/coderabbit/mono/-/merge_requests/572 --> <!-- feature-tracker-pr:http://unsafe.example/pull/1 -->",
							type: "text",
						},
					],
					role: "assistant",
				},
				sessionId: "claude-session",
				type: "assistant",
			}),
			JSON.stringify({
				prNumber: 574,
				prRepository: "coderabbitai/mono",
				prUrl: "https://github.com/coderabbitai/mono/pull/574",
				sessionId: "claude-session",
				type: "pr-link",
			}),
		].join("\n"),
	)
	const now = new Date("2026-08-31T10:02:00.000Z")
	const yesterday = new Date("2026-08-30T10:02:00.000Z")
	await Promise.all([
		utimes(codexFile, now, now),
		utimes(archivedCodexFile, yesterday, yesterday),
		utimes(claudeFile, now, now),
	])

	const sessions = await scanAgentSessions({ homeDirectory, now })
	assert.equal(sessions.length, 2)
	const codex = sessions.find(session => session.provider === "codex")
	const claude = sessions.find(session => session.provider === "claude")
	assert.equal(codex.archived, false)
	assert.deepEqual(
		{
			activity: codex.activity,
			branch: codex.branch,
			id: codex.id,
			resumeCommand: codex.resumeCommand,
			title: codex.title,
			workspace: codex.workspace,
		},
		{
			activity: "active",
			branch: "feature/codex",
			id: "codex:codex-session",
			resumeCommand: "codex resume codex-session",
			title: "Investigate REV-571 rendering issue",
			workspace: "project",
		},
	)
	assert.deepEqual(codex.titleAliases, [
		"Older generated title",
		"Follow up PR",
		"Build the session dashboard with a private token ABC-123",
	])
	assert.equal(claude.title, "Claude import flow")
	assert.equal(claude.resumeCommand, "claude --resume claude-session")
	assert.equal(codex.forkedFromId, "codex-parent")
	assert.equal(codex.launchToken, "11111111-1111-4111-8111-111111111111")
	assert.deepEqual(codex.pullRequestUrls, [
		"https://github.com/coderabbitai/mono/pull/571",
		"https://github.com/coderabbitai/mono/pull/573",
	])
	assert.deepEqual(claude.pullRequestUrls, [
		"https://gitlab.com/coderabbit/mono/-/merge_requests/572",
		"https://github.com/coderabbitai/mono/pull/574",
	])
	assert.equal(claude.relatedGroupId, "claude-root:claude-root-message")
	assert.equal(
		JSON.stringify(claude).includes("Full Claude transcript content"),
		false,
	)
})

test("builds safely quoted interactive launch commands", () => {
	const command = buildLaunchCommand({
		prompt: "Don't change unrelated files",
		provider: "claude",
		sessionId: "22222222-2222-4222-8222-222222222222",
		taskTitle: "Owner's task",
		workspacePath: "/work/a project",
	})
	assert.match(command, /^cd '\/work\/a project' && claude/u)
	assert.match(command, /Owner'"'"'s task/u)
	assert.match(command, /Don'"'"'t change unrelated files/u)
	const script = buildTerminalScript(
		command,
		"/private/tmp/feature-launch/launch.command",
	)
	assert.match(script, /^#!\/bin\/zsh/u)
	assert.match(
		script,
		/\/bin\/rm -f -- '\/private\/tmp\/feature-launch\/launch.command'/u,
	)
	assert.match(script, /\/bin\/rmdir -- '\/private\/tmp\/feature-launch'/u)
	assert.match(script, /cd '\/work\/a project' && claude/u)
	assert.equal(
		buildCodexForkCommand({
			prompt: "Wait for the user's follow-up",
			sessionId: "019fe35f-86a1-7bb2-bfb4-fc3b8005c061",
			workspacePath: "/work/a project",
		}),
		"cd '/work/a project' && codex fork --no-alt-screen -- '019fe35f-86a1-7bb2-bfb4-fc3b8005c061' 'Wait for the user'\"'\"'s follow-up'",
	)
})

test("creates, names, opens, and starts a task in the Codex app", async () => {
	const child = new EventEmitter()
	child.stdout = new PassThrough()
	child.stderr = new PassThrough()
	child.kill = () => child.emit("exit", 0, null)
	const messages = []
	const responses = new Map([
		["initialize", {}],
		["thread/start", { thread: { id: "codex-thread-1" } }],
		["thread/name/set", {}],
		["turn/start", { turn: { id: "turn-1" } }],
	])
	child.stdin = new Writable({
		write(chunk, _encoding, callback) {
			const message = JSON.parse(String(chunk))
			messages.push(message)
			if (Object.hasOwn(message, "id")) {
				queueMicrotask(() => {
					child.stdout.write(
						`${JSON.stringify({ id: message.id, result: responses.get(message.method) })}\n`,
					)
				})
			}
			callback()
		},
	})
	const openedThreads = []
	const result = await launchCodexAppSession(
		{
			prompt: "Implement the task",
			taskTitle: "Add product heat tabs",
			workspacePath: "/work/mono",
		},
		{
			openThread: async threadId => openedThreads.push(threadId),
			spawnAppServer: () => child,
		},
	)

	assert.deepEqual(result, {
		sessionId: "codex-thread-1",
		threadId: "codex-thread-1",
		turnId: "turn-1",
	})
	assert.deepEqual(
		messages.map(message => message.method),
		[
			"initialize",
			"initialized",
			"thread/start",
			"thread/name/set",
			"turn/start",
		],
	)
	assert.equal(messages[2].params.cwd, "/work/mono")
	assert.deepEqual(messages[3].params, {
		name: "Add product heat tabs",
		threadId: "codex-thread-1",
	})
	assert.deepEqual(messages[4].params.input, [
		{ text: "Implement the task", type: "text" },
	])
	assert.deepEqual(openedThreads, ["codex-thread-1"])
	assert.equal(
		buildCodexThreadUrl("codex-thread-1"),
		"codex://threads/codex-thread-1",
	)

	child.stdout.write(
		`${JSON.stringify({
			method: "turn/completed",
			params: { threadId: "codex-thread-1", turn: { id: "turn-1" } },
		})}\n`,
	)
	await new Promise(resolve => setImmediate(resolve))
	assert.equal(child.stdin.writableEnded, true)
})

test("uses Codex archive commands without editing history files", async () => {
	const commands = []
	async function runCommand(...command) {
		commands.push(command)
	}
	const sessionId = "019fe35f-86a1-7bb2-bfb4-fc3b8005c061"
	await setCodexSessionArchived({ archived: true, runCommand, sessionId })
	await setCodexSessionArchived({ archived: false, runCommand, sessionId })
	assert.deepEqual(
		commands.map(([executable, arguments_]) => [executable, arguments_]),
		[
			["codex", ["archive", sessionId]],
			["codex", ["unarchive", sessionId]],
		],
	)
	await assert.rejects(
		setCodexSessionArchived({
			archived: true,
			runCommand,
			sessionId: "--dangerous-option",
		}),
		/Codex session identifier is invalid/u,
	)
})

test("finds Codex fork chains and Claude Code histories with a shared root", () => {
	const sessions = [
		{ id: "codex:parent", provider: "codex" },
		{
			forkedFromId: "parent",
			id: "codex:child",
			provider: "codex",
		},
		{
			forkedFromId: "child",
			id: "codex:grandchild",
			provider: "codex",
		},
		{
			id: "claude:first",
			provider: "claude",
			relatedGroupId: "claude-root:shared",
		},
		{
			id: "claude:fork",
			provider: "claude",
			relatedGroupId: "claude-root:shared",
		},
	]
	assert.deepEqual(
		new Set(relatedSessionIds(["codex:parent"], sessions)),
		new Set(["codex:parent", "codex:child", "codex:grandchild"]),
	)
	assert.deepEqual(
		new Set(relatedSessionIds(["claude:fork"], sessions)),
		new Set(["claude:first", "claude:fork"]),
	)
})

test("checks one GitHub PR and the exact ready Cloud Run revision logs", async () => {
	const calls = []
	async function runCommand(command, args, options) {
		calls.push({ args, command, options })
		if (command === "gh") {
			return {
				stdout: JSON.stringify({
					headRefName: "feature/pr-agent",
					headRefOid: "abc123",
					isDraft: false,
					mergeStateStatus: "CLEAN",
					number: 571,
					reviewDecision: "APPROVED",
					state: "OPEN",
					statusCheckRollup: [
						{ conclusion: "SUCCESS", name: "Tests" },
						{ conclusion: "SUCCESS", name: "Lint" },
					],
					title: "Investigate REV-571",
					url: "https://github.com/coderabbitai/mono/pull/571",
				}),
			}
		}
		if (args[0] === "config") {
			return {
				stdout: JSON.stringify({
					core: { account: "developer@example.com", project: "demo-project" },
				}),
			}
		}
		if (args[0] === "run") {
			return {
				stdout: JSON.stringify({
					status: {
						conditions: [{ status: "True", type: "Ready" }],
						latestCreatedRevisionName: "demo-service-00042",
						latestReadyRevisionName: "demo-service-00042",
						traffic: [{ percent: 100, revisionName: "demo-service-00042" }],
					},
				}),
			}
		}
		return {
			stdout: JSON.stringify([
				{
					severity: "ERROR",
					textPayload: "A bounded post-deploy failure",
					timestamp: "2026-08-31T19:55:00.000Z",
				},
			]),
		}
	}

	const snapshot = await inspectPullRequest({
		gcpTarget: {
			project: "demo-project",
			region: "us-central1",
			service: "demo-service",
		},
		now: new Date("2026-08-31T20:00:00.000Z"),
		pullRequest: {
			label: "Investigate REV-571",
			url: "https://github.com/coderabbitai/mono/pull/571",
		},
		runCommand,
	})

	assert.equal(calls.filter(call => call.command === "gh").length, 1)
	assert.equal(calls.filter(call => call.command === "gcloud").length, 3)
	assert.ok(calls.every(call => call.options.timeoutMs > 0))
	const logCall = calls.find(call => call.args[0] === "logging")
	assert.match(logCall.args[2], /revision_name="demo-service-00042"/u)
	assert.match(logCall.args[2], /timestamp>="2026-08-31T19:30:00.000Z"/u)
	assert.match(logCall.args[2], /timestamp<="2026-08-31T20:00:00.000Z"/u)
	assert.ok(logCall.args.includes("--limit=20"))
	assert.ok(logCall.args.includes("--order=desc"))
	assert.equal(snapshot.github.status, "ready")
	assert.equal(
		snapshot.gcp.deployment.latestReadyRevision,
		"demo-service-00042",
	)
	assert.equal(
		snapshot.gcp.logs.entries[0].message,
		"A bounded post-deploy failure",
	)
	assert.equal(snapshot.status, "attention")
})

test("stops GCP inspection when the active project does not match", async () => {
	const calls = []
	const snapshot = await inspectPullRequest({
		gcpTarget: {
			project: "expected-project",
			region: "us-central1",
			service: "demo-service",
		},
		pullRequest: {
			label: "GitLab PR",
			url: "https://gitlab.com/coderabbit/mono/-/merge_requests/45",
		},
		runCommand: async (command, args) => {
			calls.push({ args, command })
			return {
				stdout: JSON.stringify({
					core: { account: "developer@example.com", project: "other-project" },
				}),
			}
		},
	})

	assert.deepEqual(calls, [
		{
			args: ["config", "list", "--format=json(core.account,core.project)"],
			command: "gcloud",
		},
	])
	assert.equal(snapshot.github.status, "unsupported")
	assert.equal(snapshot.gcp.status, "unavailable")
	assert.match(snapshot.gcp.error, /Switch it to expected-project/u)
	assert.equal(snapshot.status, "unavailable")
})

test("waits for the newest Cloud Run revision before reading its logs", async () => {
	const calls = []
	const snapshot = await inspectPullRequest({
		gcpTarget: {
			project: "demo-project",
			region: "us-central1",
			service: "demo-service",
		},
		pullRequest: {
			label: "Ready GitHub PR",
			url: "https://github.com/coderabbitai/mono/pull/571",
		},
		runCommand: async (command, args) => {
			calls.push({ args, command })
			if (command === "gh") {
				return {
					stdout: JSON.stringify({
						mergeStateStatus: "CLEAN",
						state: "MERGED",
						statusCheckRollup: [],
					}),
				}
			}
			if (args[0] === "config") {
				return {
					stdout: JSON.stringify({
						core: {
							account: "developer@example.com",
							project: "demo-project",
						},
					}),
				}
			}
			return {
				stdout: JSON.stringify({
					status: {
						conditions: [{ status: "True", type: "Ready" }],
						latestCreatedRevisionName: "demo-service-00043",
						latestReadyRevisionName: "demo-service-00042",
					},
				}),
			}
		},
	})

	assert.equal(
		calls.some(call => call.args[0] === "logging"),
		false,
	)
	assert.equal(snapshot.gcp.deployment.ready, false)
	assert.equal(snapshot.gcp.status, "pending")
	assert.equal(snapshot.status, "pending")
})

test("builds a read-only Codex goal with verified iPhone issue alerts", () => {
	const prompt = buildPrMonitorPrompt(
		{ title: "PR triage" },
		{ title: "Surface product heat" },
		{
			agent: {
				gcpTarget: {
					project: "demo-project",
					region: "us-central1",
					service: "demo-service",
				},
				lastCheck: {
					gcp: { status: "pending" },
					github: {
						checks: { failing: 1, passing: 3, pending: 2 },
						state: "OPEN",
					},
				},
			},
			label: "Product heat PR",
			url: "https://github.com/coderabbitai/mono/pull/571",
		},
		"Alert only for required checks.",
		"launch-monitor",
	)

	assert.match(prompt, /noninteractive Codex CLI job/u)
	assert.match(prompt, /Do not call create_goal/u)
	assert.match(prompt, /local notify-iphone skill/u)
	assert.match(prompt, /newly verified actionable issue/u)
	assert.match(prompt, /Do not poll GitHub/u)
	assert.match(prompt, /project demo-project, region us-central1/u)
	assert.match(prompt, /Alert only for required checks/u)
	assert.match(prompt, /feature-tracker-launch:launch-monitor/u)
})

test("builds a brokered, allowlisted Vercel Sandbox monitor", () => {
	assert.deepEqual(
		parseGitHubPullRequest("https://github.com/coderabbitai/mono/pull/571"),
		{
			name: "mono",
			number: 571,
			owner: "coderabbitai",
			url: "https://github.com/coderabbitai/mono/pull/571",
		},
	)
	const policy = buildSandboxNetworkPolicy({
		gcpAccessToken: "gcp-secret",
		githubToken: "github-secret",
		openAiApiKey: "openai-secret",
	})
	assert.deepEqual(Object.keys(policy.allow).sort(), [
		"api.github.com",
		"api.openai.com",
		"logging.googleapis.com",
		"registry.npmjs.org",
		"run.googleapis.com",
	])
	assert.match(
		policy.allow["api.openai.com"][0].transform[0].headers.authorization,
		/Bearer openai-secret/u,
	)
	assert.doesNotMatch(
		JSON.stringify(
			buildMonitorContext({
				gcpTarget: {
					project: "demo-project",
					region: "us-central1",
					service: "demo-service",
				},
				launchId: "launch-one",
				pullRequest: { url: "https://github.com/coderabbitai/mono/pull/571" },
			}),
		),
		/secret/u,
	)
	const command = buildCodexMonitorCommand()
	assert.match(command, /@openai\/codex@0\.147\.0/u)
	assert.match(command, /--sandbox read-only/u)
	assert.match(command, /--output-schema/u)
	assert.doesNotMatch(command, /openai-secret|github-secret|gcp-secret/u)
	const monitorApiScript = buildMonitorApiScript()
	assert.match(
		monitorApiScript,
		/revision\.startsWith\(`\$\{target\.service\}-`\)/u,
	)
	assert.equal(
		resolveCodexApiKey({ FEATURE_TRACKER_CODEX_API_KEY: "tracker-key" }),
		"tracker-key",
	)
})

test("builds a bounded, sanitized Codex activity timeline", () => {
	const activity = parseCodexMonitorActivity(
		[
			JSON.stringify({ type: "thread.started" }),
			JSON.stringify({ type: "turn.started" }),
			JSON.stringify({
				item: {
					command:
						"curl -H 'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz' https://api.github.com",
					type: "command_execution",
				},
				type: "item.started",
			}),
			JSON.stringify({
				item: {
					text: "The required check is still pending.",
					type: "reasoning",
				},
				type: "item.completed",
			}),
			JSON.stringify({
				item: {
					text: "I found one verified deployment issue.",
					type: "agent_message",
				},
				type: "item.completed",
			}),
			"{partially-written",
			JSON.stringify({ type: "turn.completed" }),
		].join("\n"),
		"OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz",
	)

	assert.deepEqual(
		activity.map(entry => entry.title),
		[
			"Sandbox session started",
			"Codex started monitoring",
			"Running command",
			"Progress summary",
			"Agent result",
			"Monitor pass finished",
			"Execution detail",
		],
	)
	assert.match(JSON.stringify(activity), /\[redacted\]/u)
	assert.doesNotMatch(JSON.stringify(activity), /ghp_|sk-proj-/u)
})

test("rotates across compatible reviewer OpenAI keys without using provider-specific keys", async () => {
	const directory = await temporaryDirectory()
	const envLocalPath = path.join(directory, ".env.local")
	await writeFile(
		envLocalPath,
		[
			"OPENAI_API_KEYS=pool-one,pool-two",
			"OPENAI_API_KEY=direct-one",
			"BETA_FEATURES_OPENAI_API_KEY=beta-one",
			"AZURE_OPENAI_API_KEY=azure-provider-key",
			"NVIDIA_OPENAI_KEY=nvidia-provider-key",
		].join("\n"),
	)
	assert.deepEqual(
		parseReviewerOpenAiApiKeys(await readFile(envLocalPath, "utf8")),
		["pool-one", "pool-two", "direct-one", "beta-one"],
	)
	const selected = new Set()
	for (let index = 0; index < 100; index += 1) {
		selected.add(
			await resolveCodexApiKeyForLaunch({
				environment: {},
				envLocalPath,
				launchId: `launch-${index}`,
			}),
		)
	}
	assert.deepEqual(
		selected,
		new Set(["pool-one", "pool-two", "direct-one", "beta-one"]),
	)
	assert.equal(selectCodexApiKey(["same", "same"], "launch"), "same")
})

test("reports monitor staging failures and stops the partial sandbox", async () => {
	let stopped = false
	const FailingSandbox = {
		async create() {
			return {
				async stop() {
					stopped = true
				},
				async writeFiles() {
					throw new Error("diagnostic staging failure")
				},
			}
		},
	}
	await assert.rejects(
		launchPrMonitorSandbox({
			environment: { FEATURE_TRACKER_CODEX_API_KEY: "openai-secret" },
			launchId: "launch-staging-failure",
			prompt: "Monitor the PR.",
			pullRequest: { url: "https://github.com/coderabbitai/mono/pull/571" },
			resolveBrokerCredentials: async () => ({
				githubToken: "github-secret",
			}),
			sandboxClass: FailingSandbox,
			vercelCredentials: {},
		}),
		error => {
			assert.match(error.userMessage, /could not stage its monitor files/u)
			return true
		},
	)
	assert.equal(stopped, true)
})

test("persists features, tasks, priorities, agents, and thread links", async () => {
	const directory = await temporaryDirectory()
	const dataFile = path.join(directory, "state.json")
	const store = new PlanningStore(dataFile)
	const created = await store.createFeature({
		description: "Ship a useful local tracker",
		title: "Feature session tracker",
		workItems: ["Normalize sessions", "Build the board"],
	})
	const feature = created.result
	const item = feature.workItems[0]
	assert.equal(item.priority, "medium")
	await store.updateWorkItem(feature.id, item.id, {
		agent: "codex",
		autoLinkForks: true,
		notes: "Keep both implementation threads attached.",
		priority: "high",
		pullRequests: [
			{
				createdAt: "2026-08-31T10:00:00.000Z",
				id: "pr-one",
				label: "Product heat tabs",
				url: "https://github.com/coderabbitai/mono/pull/123",
			},
			{
				url: "https://gitlab.com/coderabbit/mono/-/merge_requests/45",
			},
		],
		sessionIds: ["codex:one", "claude:two", "codex:one"],
		sessionNames: { "codex:one": "Implementation thread" },
		status: "in_progress",
		workspacePath: "/work/project",
	})

	const saved = JSON.parse(await readFile(dataFile, "utf8"))
	const savedItem = saved.features[0].workItems[0]
	assert.equal(saved.features[0].title, "Feature session tracker")
	assert.equal(savedItem.agent, "codex")
	assert.equal(savedItem.autoLinkForks, true)
	assert.equal(savedItem.notes, "Keep both implementation threads attached.")
	assert.equal(savedItem.priority, "high")
	assert.deepEqual(
		savedItem.pullRequests.map(pullRequest => ({
			label: pullRequest.label,
			url: pullRequest.url,
		})),
		[
			{
				label: "Product heat tabs",
				url: "https://github.com/coderabbitai/mono/pull/123",
			},
			{
				label: "PR #45",
				url: "https://gitlab.com/coderabbit/mono/-/merge_requests/45",
			},
		],
	)
	assert.equal(savedItem.status, "in_progress")
	assert.equal(savedItem.statusHistory.length, 2)
	assert.deepEqual(
		{
			from: savedItem.statusHistory[1].from,
			source: savedItem.statusHistory[1].source,
			to: savedItem.statusHistory[1].to,
		},
		{ from: "planned", source: "manual", to: "in_progress" },
	)
	assert.equal(savedItem.workspacePath, "/work/project")
	assert.deepEqual(savedItem.sessionIds, ["codex:one", "claude:two"])
	assert.deepEqual(savedItem.sessionNames, {
		"codex:one": "Implementation thread",
	})
	await store.updatePullRequestAgent(feature.id, item.id, "pr-one", {
		gcpTarget: {
			project: "demo-project",
			region: "us-central1",
			service: "demo-service",
		},
		lastCheck: {
			checkedAt: "2026-08-31T20:00:00.000Z",
			gcp: { status: "not_configured" },
			github: {
				checks: { failing: 0, passing: 2, pending: 0, total: 2 },
				state: "OPEN",
				status: "ready",
			},
			status: "healthy",
		},
	})
	const savedAgent = (await store.read()).features[0].workItems[0]
		.pullRequests[0].agent
	assert.equal(savedAgent.gcpTarget.service, "demo-service")
	assert.equal(savedAgent.lastCheck.github.checks.passing, 2)
	assert.equal(savedAgent.lastCheck.status, "healthy")
	assert.equal((await store.read()).features.length, 1)
	await store.updateWorkItem(feature.id, item.id, { status: "in_progress" })
	assert.equal(
		(await store.read()).features[0].workItems[0].statusHistory.length,
		2,
	)
	await store.recordSessionLaunch(feature.id, item.id, {
		id: "launch-one",
		provider: "claude",
		sessionId: "new-session",
		startedAt: "2026-08-31T10:00:00.000Z",
		token: "33333333-3333-4333-8333-333333333333",
		workspacePath: "/work/project",
	})
	const launched = await store.reconcilePendingLaunches([
		{
			id: "claude:new-session",
			provider: "claude",
			sessionId: "new-session",
		},
	])
	assert.equal(launched.result.linked, 1)
	assert.deepEqual(launched.state.features[0].workItems[0].pendingLaunches, [])
	const reconciliation = await store.reconcileRelatedSessions([
		{ id: "codex:one", provider: "codex" },
		{ forkedFromId: "one", id: "codex:child", provider: "codex" },
		{ id: "claude:new-session", provider: "claude" },
	])
	assert.equal(reconciliation.result.added, 1)
	assert.deepEqual(reconciliation.state.features[0].workItems[0].sessionIds, [
		"codex:one",
		"claude:two",
		"claude:new-session",
		"codex:child",
	])
	const pullRequestReconciliation = await store.reconcileSessionPullRequests(
		[
			{
				id: "codex:one",
				pullRequestUrls: [
					"https://github.com/coderabbitai/mono/pull/123",
					"https://github.com/coderabbitai/mono/pull/999",
				],
			},
			{
				id: "codex:child",
				pullRequestUrls: ["https://github.com/coderabbitai/mono/pull/1000"],
			},
			{
				id: "codex:unlinked",
				pullRequestUrls: ["https://github.com/coderabbitai/mono/pull/2000"],
			},
		],
		new Date("2026-08-31T20:15:00.000Z"),
	)
	assert.equal(pullRequestReconciliation.result.linked, 2)
	assert.deepEqual(
		pullRequestReconciliation.state.features[0].workItems[0].pullRequests.map(
			pullRequest => pullRequest.url,
		),
		[
			"https://github.com/coderabbitai/mono/pull/123",
			"https://gitlab.com/coderabbit/mono/-/merge_requests/45",
			"https://github.com/coderabbitai/mono/pull/999",
			"https://github.com/coderabbitai/mono/pull/1000",
		],
	)
	await assert.rejects(
		store.setWorkItemArchived(feature.id, item.id, true),
		/Only completed tasks can be archived/u,
	)
	await store.updateWorkItem(feature.id, item.id, { status: "done" })
	const archived = await store.setWorkItemArchived(
		feature.id,
		item.id,
		true,
		new Date("2026-08-31T20:20:00.000Z"),
	)
	assert.equal(
		archived.state.features[0].workItems[0].archivedAt,
		"2026-08-31T20:20:00.000Z",
	)
	assert.deepEqual(archived.state.features[0].workItems[0].sessionIds, [
		"codex:one",
		"claude:two",
		"claude:new-session",
		"codex:child",
	])
	assert.equal(archived.state.features[0].workItems[0].pullRequests.length, 4)
	const unarchived = await store.setWorkItemArchived(
		feature.id,
		item.id,
		false,
		new Date("2026-08-31T20:25:00.000Z"),
	)
	assert.equal(unarchived.state.features[0].workItems[0].archivedAt, "")
	await assert.rejects(
		store.updateWorkItem(feature.id, item.id, { priority: "critical" }),
		/Unsupported task priority/u,
	)
	await assert.rejects(
		store.updateWorkItem(feature.id, item.id, {
			pullRequests: [{ url: "javascript:alert(1)" }],
		}),
		/Pull request URL must use HTTP or HTTPS/u,
	)
})

test("imports legacy planning data into PostgreSQL once and keeps the file backup", async () => {
	const directory = await temporaryDirectory()
	const dataFile = path.join(directory, "state.json")
	const legacyState = { features: [], version: 1 }
	await writeFile(dataFile, `${JSON.stringify(legacyState)}\n`)
	const database = {
		ended: false,
		schemaApplied: false,
		state: null,
		async end() {
			this.ended = true
		},
		async query(sql, parameters = []) {
			const statement = sql.trim()
			if (statement.startsWith("CREATE TABLE")) {
				this.schemaApplied = true
				return { rows: [] }
			}
			if (statement.startsWith("SELECT state")) {
				return { rows: this.state == null ? [] : [{ state: this.state }] }
			}
			if (statement.includes("ON CONFLICT (key) DO NOTHING")) {
				if (this.state == null) this.state = JSON.parse(parameters[1])
				return { rows: [] }
			}
			if (statement.includes("ON CONFLICT (key) DO UPDATE")) {
				this.state = JSON.parse(parameters[1])
				return { rows: [] }
			}
			throw new Error(`Unexpected SQL: ${statement}`)
		},
	}
	const persistence = new PostgresPlanningPersistence({
		legacyDataFile: dataFile,
		pool: database,
	})
	const store = new PlanningStore(persistence)
	assert.deepEqual(await store.read(), legacyState)
	assert.equal(database.schemaApplied, true)
	await store.createFeature({
		description: "Stored in PostgreSQL",
		title: "Durable tracker",
		workItems: ["Keep task history"],
	})
	assert.equal(database.state.features[0].title, "Durable tracker")
	assert.deepEqual(JSON.parse(await readFile(dataFile, "utf8")), legacyState)
	await store.close()
	assert.equal(database.ended, true)
})

test("serves the local workflow and protects mutations from cross-origin forms", async () => {
	const directory = await temporaryDirectory()
	let sessions = [
		{
			activity: "recent",
			archived: false,
			branch: "main",
			cwd: "/work/project",
			id: "codex:one",
			provider: "codex",
			resumeCommand: "codex resume one",
			sessionId: "one",
			startedAt: "2026-08-31T10:00:00.000Z",
			title: "A Codex session",
			updatedAt: "2026-08-31T10:10:00.000Z",
			workspace: "project",
		},
	]
	const launches = []
	const forkLaunches = []
	const sandboxLaunches = []
	const sandboxActivityReads = []
	const archiveChanges = []
	const notifications = []
	const prChecks = []
	let completeMonitor
	const monitorCompletion = new Promise(resolve => {
		completeMonitor = resolve
	})
	const server = createTrackerServer({
		dataFile: path.join(directory, "state.json"),
		defaultWorkspace: directory,
		homeDirectory: directory,
		inspectPr: async input => {
			prChecks.push(input)
			return {
				checkedAt: "2026-08-31T20:00:00.000Z",
				gcp: { status: "not_configured" },
				github: {
					checks: { failing: 0, passing: 1, pending: 0, total: 1 },
					state: "OPEN",
					status: "ready",
				},
				status: "healthy",
			}
		},
		launchMonitor: async input => {
			sandboxLaunches.push(input)
			return {
				completion: monitorCompletion,
				run: {
					commandId: "cmd-monitor",
					expiresAt: "2026-08-31T20:30:00.000Z",
					provider: "vercel",
					sandboxId: "sbx-monitor",
					startedAt: "2026-08-31T20:00:00.000Z",
					status: "running",
				},
			}
		},
		launchFork: async input => forkLaunches.push(input),
		launchSession: async input => {
			launches.push(input)
			return input.provider === "codex" ? { threadId: "codex-app-thread" } : {}
		},
		notifyIssues: async issues => notifications.push(...issues),
		readMonitorActivity: async input => {
			sandboxActivityReads.push(input)
			return {
				activity: [
					{
						detail: "Checking required GitHub checks.",
						kind: "progress",
						title: "Progress summary",
					},
				],
				available: true,
			}
		},
		scanSessions: async () => sessions,
		setSessionArchived: async input => {
			archiveChanges.push(input)
			sessions = sessions.map(session =>
				session.sessionId === input.sessionId
					? { ...session, archived: input.archived }
					: session,
			)
		},
	})
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	const baseUrl = `http://127.0.0.1:${address.port}`
	try {
		const bootstrap = await fetch(`${baseUrl}/api/bootstrap`).then(response =>
			response.json(),
		)
		assert.equal(bootstrap.sessions[0].provider, "codex")
		assert.equal(bootstrap.defaultWorkspace, directory)
		assert.deepEqual(bootstrap.features, [])

		const rejected = await fetch(`${baseUrl}/api/features`, {
			body: JSON.stringify({ title: "Rejected" }),
			headers: { "Content-Type": "application/json" },
			method: "POST",
		})
		assert.equal(rejected.status, 403)

		const createdResponse = await fetch(`${baseUrl}/api/features`, {
			body: JSON.stringify({
				description: "Local only",
				title: "Accepted",
				workItems: ["First item"],
			}),
			headers: {
				"Content-Type": "application/json",
				"X-Feature-Tracker": "1",
			},
			method: "POST",
		})
		assert.equal(createdResponse.status, 200)
		const created = await createdResponse.json()
		assert.equal(created.features[0].workItems.length, 1)
		const feature = created.features[0]
		const item = feature.workItems[0]
		const linkedResponse = await fetch(
			`${baseUrl}/api/features/${feature.id}/items/${item.id}`,
			{
				body: JSON.stringify({
					pullRequests: [
						{
							id: "pr-route-test",
							label: "Route test PR",
							url: "https://github.com/coderabbitai/mono/pull/571",
						},
					],
				}),
				headers: {
					"Content-Type": "application/json",
					"X-Feature-Tracker": "1",
				},
				method: "PATCH",
			},
		)
		assert.equal(linkedResponse.status, 200)
		const checkedResponse = await fetch(
			`${baseUrl}/api/features/${feature.id}/items/${item.id}/pull-requests/pr-route-test/check`,
			{
				body: JSON.stringify({
					gcpTarget: {
						project: "demo-project",
						region: "us-central1",
						service: "demo-service",
					},
				}),
				headers: {
					"Content-Type": "application/json",
					"X-Feature-Tracker": "1",
				},
				method: "POST",
			},
		)
		assert.equal(checkedResponse.status, 200)
		const checked = await checkedResponse.json()
		assert.equal(prChecks.length, 1)
		assert.equal(prChecks[0].pullRequest.id, "pr-route-test")
		assert.equal(checked.result.agent.lastCheck.status, "healthy")
		assert.equal(checked.result.agent.gcpTarget.service, "demo-service")
		const launchedResponse = await fetch(
			`${baseUrl}/api/features/${feature.id}/items/${item.id}/launch`,
			{
				body: JSON.stringify({
					context: "Start with the smallest change",
					provider: "codex",
					workspacePath: directory,
				}),
				headers: {
					"Content-Type": "application/json",
					"X-Feature-Tracker": "1",
				},
				method: "POST",
			},
		)
		assert.equal(launchedResponse.status, 200)
		const launched = await launchedResponse.json()
		assert.equal(launches.length, 1)
		assert.equal(launches[0].provider, "codex")
		assert.equal(launches[0].workspacePath, directory)
		assert.equal(launched.result.threadId, "codex-app-thread")
		assert.match(
			launches[0].prompt,
			new RegExp(`feature-tracker-launch:${launched.result.launchId}`, "u"),
		)
		assert.match(
			launches[0].prompt,
			/feature-tracker-pr:FULL_HTTPS_PULL_REQUEST_URL/u,
		)
		assert.equal(launched.features[0].workItems[0].status, "in_progress")
		assert.deepEqual(
			{
				from: launched.features[0].workItems[0].statusHistory.at(-1).from,
				source: launched.features[0].workItems[0].statusHistory.at(-1).source,
				to: launched.features[0].workItems[0].statusHistory.at(-1).to,
			},
			{ from: "planned", source: "session_started", to: "in_progress" },
		)
		assert.equal(launched.features[0].workItems[0].pendingLaunches.length, 1)

		sessions = [
			...sessions,
			{
				...sessions[0],
				id: "codex:started",
				launchToken: launched.result.launchId,
				pullRequestUrls: ["https://github.com/coderabbitai/mono/pull/572"],
				sessionId: "started",
				title: "First item",
			},
		]
		const refreshed = await fetch(`${baseUrl}/api/bootstrap?refresh=1`).then(
			response => response.json(),
		)
		assert.equal(refreshed.launchedLinkedCount, 1)
		assert.equal(refreshed.pullRequestsLinkedCount, 1)
		assert.deepEqual(refreshed.features[0].workItems[0].sessionIds, [
			"codex:started",
		])
		assert.deepEqual(
			refreshed.features[0].workItems[0].pullRequests.map(
				pullRequest => pullRequest.url,
			),
			[
				"https://github.com/coderabbitai/mono/pull/571",
				"https://github.com/coderabbitai/mono/pull/572",
			],
		)
		assert.deepEqual(refreshed.features[0].workItems[0].pendingLaunches, [])

		const monitorResponse = await fetch(
			`${baseUrl}/api/features/${feature.id}/items/${item.id}/pull-requests/pr-route-test/monitor`,
			{
				body: JSON.stringify({
					instructions: "Alert when a required check fails.",
					workspacePath: directory,
				}),
				headers: {
					"Content-Type": "application/json",
					"X-Feature-Tracker": "1",
				},
				method: "POST",
			},
		)
		assert.equal(monitorResponse.status, 200)
		const monitor = await monitorResponse.json()
		assert.equal(launches.length, 1)
		assert.equal(sandboxLaunches.length, 1)
		assert.match(sandboxLaunches[0].prompt, /Do not call create_goal/u)
		assert.match(
			sandboxLaunches[0].prompt,
			/Alert when a required check fails/u,
		)
		assert.match(sandboxLaunches[0].prompt, /service demo-service/u)
		assert.equal(monitor.result.pullRequestId, "pr-route-test")
		assert.equal(monitor.result.provider, "vercel")
		assert.equal(monitor.result.sandboxId, "sbx-monitor")
		const activityResponse = await fetch(
			`${baseUrl}/api/features/${feature.id}/items/${item.id}/pull-requests/pr-route-test/monitor-runs/${monitor.result.launchId}/activity`,
			{
				body: "{}",
				headers: {
					"Content-Type": "application/json",
					"X-Feature-Tracker": "1",
				},
				method: "POST",
			},
		)
		assert.equal(activityResponse.status, 200)
		const activity = await activityResponse.json()
		assert.equal(sandboxActivityReads.length, 1)
		assert.equal(sandboxActivityReads[0].run.sandboxId, "sbx-monitor")
		assert.equal(activity.activity[0].title, "Progress summary")
		const activityStored = await fetch(`${baseUrl}/api/bootstrap`).then(
			response => response.json(),
		)
		assert.equal(
			activityStored.features[0].workItems[0].pullRequests[0].agent
				.monitorRuns[0].activity[0].title,
			"Progress summary",
		)
		completeMonitor({
			activity: [
				{
					detail: "The required build check failed.",
					kind: "result",
					title: "Agent result",
				},
			],
			completedAt: "2026-08-31T20:05:00.000Z",
			status: "issue",
			summary: "One required check failed.",
			verifiedIssues: [
				{
					message: "The required build check failed.",
					severity: "error",
					title: "Required PR check failed",
				},
			],
		})
		await new Promise(resolve => setTimeout(resolve, 0))
		const monitorRefreshed = await fetch(
			`${baseUrl}/api/bootstrap?refresh=1`,
		).then(response => response.json())
		const monitoredItem = monitorRefreshed.features[0].workItems[0]
		assert.equal(monitorRefreshed.launchedLinkedCount, 0)
		assert.equal(monitorRefreshed.pullRequestsLinkedCount, 0)
		assert.deepEqual(monitoredItem.sessionIds, ["codex:started"])
		assert.equal(monitoredItem.pullRequests[0].agent.monitorRuns.length, 1)
		assert.equal(
			monitoredItem.pullRequests[0].agent.monitorRuns[0].status,
			"issue",
		)
		assert.equal(
			monitoredItem.pullRequests[0].agent.monitorRuns[0].verifiedIssueCount,
			1,
		)
		assert.equal(
			monitoredItem.pullRequests[0].agent.monitorRuns[0].activity[0].title,
			"Agent result",
		)
		assert.equal(notifications.length, 1)

		const doneResponse = await fetch(
			`${baseUrl}/api/features/${feature.id}/items/${item.id}`,
			{
				body: JSON.stringify({ status: "done" }),
				headers: {
					"Content-Type": "application/json",
					"X-Feature-Tracker": "1",
				},
				method: "PATCH",
			},
		)
		assert.equal(doneResponse.status, 200)
		const archiveResponse = await fetch(
			`${baseUrl}/api/features/${feature.id}/items/${item.id}/archive`,
			{
				body: "{}",
				headers: {
					"Content-Type": "application/json",
					"X-Feature-Tracker": "1",
				},
				method: "POST",
			},
		)
		assert.equal(archiveResponse.status, 200)
		const archivedTask = await archiveResponse.json()
		assert.equal(archivedTask.result.codexSessionsChanged, 1)
		assert.equal(Boolean(archivedTask.result.item.archivedAt), true)
		assert.deepEqual(archivedTask.result.item.sessionIds, ["codex:started"])
		assert.equal(archivedTask.result.item.pullRequests.length, 2)
		assert.deepEqual(archiveChanges[0], {
			archived: true,
			sessionId: "started",
		})

		const forkResponse = await fetch(
			`${baseUrl}/api/features/${feature.id}/items/${item.id}/sessions/${encodeURIComponent("codex:started")}/fork`,
			{
				body: "{}",
				headers: {
					"Content-Type": "application/json",
					"X-Feature-Tracker": "1",
				},
				method: "POST",
			},
		)
		assert.equal(forkResponse.status, 200)
		const forked = await forkResponse.json()
		assert.equal(forkLaunches.length, 1)
		assert.equal(forkLaunches[0].sessionId, "started")
		assert.match(
			forkLaunches[0].prompt,
			new RegExp(`feature-tracker-launch:${forked.result.launchId}`, "u"),
		)
		assert.equal(
			forked.features[0].workItems[0].pendingLaunches.at(-1).id,
			forked.result.launchId,
		)

		const unarchiveResponse = await fetch(
			`${baseUrl}/api/features/${feature.id}/items/${item.id}/unarchive`,
			{
				body: "{}",
				headers: {
					"Content-Type": "application/json",
					"X-Feature-Tracker": "1",
				},
				method: "POST",
			},
		)
		assert.equal(unarchiveResponse.status, 200)
		const unarchivedTask = await unarchiveResponse.json()
		assert.equal(unarchivedTask.result.item.archivedAt, "")
		assert.deepEqual(archiveChanges.at(-1), {
			archived: false,
			sessionId: "started",
		})

		const rearchiveResponse = await fetch(
			`${baseUrl}/api/features/${feature.id}/items/${item.id}/archive`,
			{
				body: "{}",
				headers: {
					"Content-Type": "application/json",
					"X-Feature-Tracker": "1",
				},
				method: "POST",
			},
		)
		assert.equal(rearchiveResponse.status, 200)
		const rearchivedTask = await rearchiveResponse.json()
		assert.equal(Boolean(rearchivedTask.result.item.archivedAt), true)
		assert.deepEqual(archiveChanges.at(-1), {
			archived: true,
			sessionId: "started",
		})
	} finally {
		await new Promise((resolve, reject) => {
			server.close(error => (error ? reject(error) : resolve()))
		})
	}
})
