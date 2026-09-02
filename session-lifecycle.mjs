import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const CODEX_SESSION_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

export async function setCodexSessionArchived({
	archived,
	runCommand = execFileAsync,
	sessionId,
}) {
	if (!CODEX_SESSION_ID_PATTERN.test(sessionId)) {
		throw new TypeError("Codex session identifier is invalid")
	}
	try {
		await runCommand("codex", [archived ? "archive" : "unarchive", sessionId], {
			maxBuffer: 256 * 1024,
			timeout: 15_000,
		})
	} catch (cause) {
		const error = new Error("Unable to change the Codex archive", { cause })
		error.userMessage = archived
			? "Codex could not archive one of the linked sessions. Nothing was removed from the tracker."
			: "Codex could not restore one of the linked sessions. The task remains archived in the tracker."
		throw error
	}
}

export const internals = { CODEX_SESSION_ID_PATTERN }
