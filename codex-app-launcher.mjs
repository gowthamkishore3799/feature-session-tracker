import { execFile, spawn } from "node:child_process"
import process from "node:process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const CODEX_APP_BUNDLE_ID = "com.openai.codex"
const REQUEST_TIMEOUT_MS = 30_000

export function buildCodexThreadUrl(threadId) {
	if (typeof threadId !== "string" || !threadId.trim()) {
		throw new TypeError("Codex thread identifier is required")
	}
	return `codex://threads/${encodeURIComponent(threadId.trim())}`
}

function defaultSpawnAppServer({ workspacePath }) {
	return spawn("codex", ["app-server", "--stdio"], {
		cwd: workspacePath,
		env: process.env,
		stdio: ["pipe", "pipe", "pipe"],
	})
}

async function defaultOpenThread(threadId) {
	if (process.platform !== "darwin") {
		throw new Error("The Codex desktop app launcher requires macOS")
	}
	await execFileAsync(
		"/usr/bin/open",
		["-b", CODEX_APP_BUNDLE_ID, buildCodexThreadUrl(threadId)],
		{ timeout: 5_000 },
	)
}

function createJsonRpcClient(
	child,
	{ requestTimeoutMs = REQUEST_TIMEOUT_MS } = {},
) {
	let buffer = ""
	let closed = false
	let nextRequestId = 0
	let stderr = ""
	const notificationListeners = new Set()
	const pending = new Map()

	child.stdout.setEncoding("utf8")
	child.stderr.setEncoding("utf8")

	function failureMessage(fallback) {
		const detail = stderr.trim().split("\n").at(-1)
		return detail ? `${fallback}: ${detail}` : fallback
	}

	function settlePending(error) {
		for (const entry of pending.values()) {
			clearTimeout(entry.timer)
			entry.reject(error)
		}
		pending.clear()
	}

	function fail(error) {
		if (closed) return
		closed = true
		settlePending(error)
	}

	function handleMessage(message) {
		if (message && Object.hasOwn(message, "id")) {
			const entry = pending.get(message.id)
			if (!entry) return
			pending.delete(message.id)
			clearTimeout(entry.timer)
			if (message.error) {
				entry.reject(
					new Error(
						message.error.message || "Codex App Server rejected the request",
					),
				)
				return
			}
			entry.resolve(message.result)
			return
		}
		if (message?.method) {
			for (const listener of notificationListeners) listener(message)
		}
	}

	child.stdout.on("data", chunk => {
		buffer += chunk
		for (;;) {
			const newlineIndex = buffer.indexOf("\n")
			if (newlineIndex < 0) break
			const line = buffer.slice(0, newlineIndex).trim()
			buffer = buffer.slice(newlineIndex + 1)
			if (!line) continue
			try {
				handleMessage(JSON.parse(line))
			} catch {
				fail(new Error("Codex App Server returned an invalid response"))
			}
		}
	})
	child.stderr.on("data", chunk => {
		stderr = `${stderr}${chunk}`.slice(-8_000)
	})
	child.once("error", error => {
		fail(new Error(failureMessage(error.message), { cause: error }))
	})
	child.once("exit", (code, signal) => {
		if (closed) return
		const reason = signal ? `signal ${signal}` : `exit status ${code}`
		fail(new Error(failureMessage(`Codex App Server stopped with ${reason}`)))
	})

	function request(method, params) {
		if (closed) return Promise.reject(new Error("Codex App Server is closed"))
		const id = ++nextRequestId
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id)
				reject(new Error(`Codex App Server timed out during ${method}`))
			}, requestTimeoutMs)
			timer.unref()
			pending.set(id, { reject, resolve, timer })
			child.stdin.write(
				`${JSON.stringify({ id, method, params })}\n`,
				error => {
					if (!error) return
					const entry = pending.get(id)
					if (!entry) return
					pending.delete(id)
					clearTimeout(entry.timer)
					entry.reject(error)
				},
			)
		})
	}

	function notify(method, params = {}) {
		if (closed) throw new Error("Codex App Server is closed")
		child.stdin.write(`${JSON.stringify({ method, params })}\n`)
	}

	function onNotification(listener) {
		notificationListeners.add(listener)
		return () => notificationListeners.delete(listener)
	}

	function close() {
		if (closed) return
		closed = true
		settlePending(new Error("Codex App Server was closed"))
		child.stdin.end()
		const killTimer = setTimeout(() => child.kill("SIGTERM"), 2_000)
		killTimer.unref()
	}

	return { close, notify, onNotification, request }
}

export async function launchCodexAppSession(
	{ prompt, taskTitle, workspacePath },
	{
		openThread = defaultOpenThread,
		requestTimeoutMs = REQUEST_TIMEOUT_MS,
		spawnAppServer = defaultSpawnAppServer,
	} = {},
) {
	const child = spawnAppServer({ workspacePath })
	const client = createJsonRpcClient(child, { requestTimeoutMs })
	try {
		await client.request("initialize", {
			capabilities: { experimentalApi: false },
			clientInfo: {
				name: "feature_session_tracker",
				title: "Feature session tracker",
				version: "1.0.0",
			},
		})
		client.notify("initialized")
		const threadResponse = await client.request("thread/start", {
			cwd: workspacePath,
			serviceName: "feature-session-tracker",
		})
		const threadId = threadResponse?.thread?.id
		if (typeof threadId !== "string" || !threadId) {
			throw new Error("Codex App Server did not return a thread identifier")
		}
		await client.request("thread/name/set", {
			name: taskTitle,
			threadId,
		})
		await openThread(threadId)
		const turnResponse = await client.request("turn/start", {
			cwd: workspacePath,
			input: [{ text: prompt, type: "text" }],
			threadId,
		})
		const turnId = turnResponse?.turn?.id
		if (typeof turnId !== "string" || !turnId) {
			throw new Error("Codex App Server did not start the first turn")
		}

		const stopListening = client.onNotification(message => {
			if (
				message.method !== "turn/completed" ||
				message.params?.threadId !== threadId ||
				message.params?.turn?.id !== turnId
			) {
				return
			}
			stopListening()
			client.close()
		})
		return { sessionId: threadId, threadId, turnId }
	} catch (cause) {
		client.close()
		const error = new Error("Unable to create a task in the Codex app", {
			cause,
		})
		error.userMessage =
			"Unable to create a Codex app task. Make sure the Codex app and CLI are installed and signed in, then try again."
		throw error
	}
}

export const internals = {
	createJsonRpcClient,
	defaultOpenThread,
	defaultSpawnAppServer,
}
