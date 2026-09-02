#!/usr/bin/env node

import { Sandbox } from "@vercel/sandbox"

process.stdout.write(
	"Connecting this Mac to Vercel. Follow the device sign-in link if one appears.\n",
)

let sandbox
try {
	sandbox = await Sandbox.create({
		networkPolicy: "deny-all",
		persistent: false,
		resources: { vcpus: 1 },
		runtime: "node24",
		tags: { app: "feature-tracker", purpose: "auth-check" },
		timeout: 5 * 60 * 1_000,
	})
	const command = await sandbox.runCommand({
		args: ["-v"],
		cmd: "node",
	})
	if (command.exitCode !== 0) {
		throw new Error("The Vercel Sandbox smoke test did not complete.")
	}
	process.stdout.write(
		`Vercel Sandbox is ready (${sandbox.sandboxId || sandbox.name}).\n`,
	)
} finally {
	if (sandbox) await sandbox.stop().catch(() => undefined)
}
