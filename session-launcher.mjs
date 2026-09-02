import { execFile } from "node:child_process"
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { promisify } from "node:util"
import { launchCodexAppSession } from "./codex-app-launcher.mjs"

const execFileAsync = promisify(execFile)

function shellQuote(value) {
	return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

export function buildLaunchCommand({
	prompt,
	provider,
	sessionId,
	taskTitle,
	workspacePath,
}) {
	const changeDirectory = `cd ${shellQuote(workspacePath)}`
	if (provider === "codex") {
		return `${changeDirectory} && codex --no-alt-screen -- ${shellQuote(prompt)}`
	}
	if (provider === "claude") {
		return `${changeDirectory} && claude --name ${shellQuote(taskTitle)} --session-id ${shellQuote(sessionId)} ${shellQuote(prompt)}`
	}
	throw new TypeError("Unsupported agent")
}

export function buildCodexForkCommand({ prompt, sessionId, workspacePath }) {
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
			sessionId,
		)
	) {
		throw new TypeError("Codex session identifier is invalid")
	}
	return `cd ${shellQuote(workspacePath)} && codex fork --no-alt-screen -- ${shellQuote(sessionId)} ${shellQuote(prompt)}`
}

export function buildTerminalScript(command, scriptPath) {
	return [
		"#!/bin/zsh",
		`/bin/rm -f -- ${shellQuote(scriptPath)}`,
		`/bin/rmdir -- ${shellQuote(path.dirname(scriptPath))} 2>/dev/null || true`,
		command,
		"",
	].join("\n")
}

async function cleanupLaunchScript(scriptPath) {
	await unlink(scriptPath).catch(() => undefined)
	await rmdir(path.dirname(scriptPath)).catch(() => undefined)
}

export async function launchAgentSession(options, dependencies) {
	if (options.provider === "codex") {
		return launchCodexAppSession(options, dependencies)
	}
	return launchTerminalCommand(buildLaunchCommand(options))
}

export async function launchCodexForkSession(options) {
	return launchTerminalCommand(buildCodexForkCommand(options))
}

async function launchTerminalCommand(command) {
	if (process.platform !== "darwin") {
		const error = new Error("Unsupported operating system")
		error.userMessage = "Starting sessions is currently supported on macOS."
		throw error
	}

	const launchDirectory = await mkdtemp(
		path.join(os.tmpdir(), "feature-tracker-launch-"),
	)
	const scriptPath = path.join(launchDirectory, "launch.command")
	try {
		await writeFile(scriptPath, buildTerminalScript(command, scriptPath), {
			mode: 0o700,
		})
		await execFileAsync("/usr/bin/open", ["-a", "Terminal", scriptPath], {
			timeout: 5_000,
		})
		const cleanupTimer = setTimeout(
			() => void cleanupLaunchScript(scriptPath),
			60_000,
		)
		cleanupTimer.unref()
	} catch (cause) {
		await cleanupLaunchScript(scriptPath)
		const error = new Error("Unable to open Terminal", { cause })
		error.userMessage =
			"Unable to open Terminal within 5 seconds. Open Terminal once, then try again."
		throw error
	}
}

export const internals = { cleanupLaunchScript, shellQuote }
