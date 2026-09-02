import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"

const { Pool } = pg
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const migrationFile = path.join(
	scriptDirectory,
	"migrations",
	"001_create_tracker_state.sql",
)
const STATE_KEY = "default"

function unavailableError(error) {
	error.userMessage =
		"PostgreSQL is unavailable. Start it with pnpm feature-sessions:db."
	return error
}

export class PostgresPlanningPersistence {
	#initialized = null
	#legacyDataFile
	#pool

	constructor({ connectionString, legacyDataFile, pool } = {}) {
		this.#legacyDataFile = legacyDataFile
		this.#pool =
			pool ??
			new Pool({
				allowExitOnIdle: true,
				connectionString,
				connectionTimeoutMillis: 3_000,
				idleTimeoutMillis: 10_000,
				max: 3,
			})
	}

	async #initialize() {
		if (!this.#initialized) {
			this.#initialized = readFile(migrationFile, "utf8")
				.then(sql => this.#pool.query(sql))
				.catch(error => {
					this.#initialized = null
					throw unavailableError(error)
				})
		}
		await this.#initialized
	}

	async #legacyState() {
		if (!this.#legacyDataFile) return null
		try {
			return JSON.parse(await readFile(this.#legacyDataFile, "utf8"))
		} catch (error) {
			if (error?.code === "ENOENT") return null
			throw error
		}
	}

	async read() {
		await this.#initialize()
		try {
			let result = await this.#pool.query(
				"SELECT state FROM feature_tracker_state WHERE key = $1",
				[STATE_KEY],
			)
			if (result.rows[0]) return result.rows[0].state

			const legacyState = await this.#legacyState()
			if (legacyState == null) return null
			await this.#pool.query(
				`INSERT INTO feature_tracker_state (key, state, version)
				 VALUES ($1, $2::jsonb, $3)
				 ON CONFLICT (key) DO NOTHING`,
				[STATE_KEY, JSON.stringify(legacyState), legacyState.version ?? 1],
			)
			result = await this.#pool.query(
				"SELECT state FROM feature_tracker_state WHERE key = $1",
				[STATE_KEY],
			)
			return result.rows[0]?.state ?? null
		} catch (error) {
			throw unavailableError(error)
		}
	}

	async write(state) {
		await this.#initialize()
		try {
			await this.#pool.query(
				`INSERT INTO feature_tracker_state (key, state, version, updated_at)
				 VALUES ($1, $2::jsonb, $3, NOW())
				 ON CONFLICT (key) DO UPDATE
				 SET state = EXCLUDED.state,
				     version = EXCLUDED.version,
				     updated_at = NOW()`,
				[STATE_KEY, JSON.stringify(state), state.version ?? 1],
			)
		} catch (error) {
			throw unavailableError(error)
		}
	}

	async close() {
		await this.#pool.end()
	}
}
