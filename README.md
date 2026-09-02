# Feature tracker

A private local web app for breaking a feature into trackable tasks and keeping
the Codex and Claude Code threads used for each task visible in one place.

Each task has a status, priority, preferred agent, notes, and any number of
linked threads and pull requests. You can link both Codex and Claude Code
threads to the same task, give each linked thread a task-specific name, and keep
multiple GitHub, GitLab, Bitbucket, or self-hosted pull request URLs alongside
the work. Pull request links are stored locally. For a GitHub.com pull request,
open **PR agent** and explicitly run a bounded status check using the signed-in
local `gh` CLI. The tracker makes one request for that PR and never polls GitHub
in the background.

Each PR agent can optionally store a GCP project, region, and Cloud Run service.
When you run a check, the tracker verifies that the signed-in local `gcloud`
project matches, reads the service's deployment state, and waits for the newest
revision to be ready before querying its ERROR logs. The log query targets that
exact revision, covers the last 30 minutes, and returns at most 20 entries. The
latest sanitized snapshot and a copyable Logs Explorer filter are stored with
the PR; local GitHub and Google Cloud credentials are never stored.

Every linked pull request also has its own **Monitor** button. Enter custom
instructions to create an isolated Vercel Sandbox and start Codex CLI there in
noninteractive, read-only mode. The tracker stores the sandbox and command IDs
with that PR. GitHub and short-lived Google Cloud credentials are inserted by
Vercel's network policy and are never written to the sandbox. Codex performs
one bounded GitHub assessment and—when a Cloud Run target is configured—one
deployment read plus a bounded post-deploy log query. After Codex returns a
structured verified result, this Mac invokes the installed `notify-iphone`
skill for newly verified actionable issues.

Use **Start Codex** on any task to create, name, and open a new task directly in
the Codex desktop app. **Start Claude** opens an interactive Claude Code session
in Terminal. In both cases, the task name, feature outcome, notes, and optional
extra instructions become the first message. The tracker remembers the task's
workspace folder, moves a planned task to In progress, and links the new session
as soon as it appears in local history. When a linked thread creates a pull
request, the local scan recognizes Claude Code's dedicated PR event or the
result of Codex's PR-creation command and automatically attaches the URL to the
same task. A private tracker marker in the final response remains as a fallback.
The tracker ignores ordinary PR links mentioned during investigation, does not
expose the surrounding transcript, and does not query GitHub in the background.

Every task status transition is stored with its timestamp. Open **Team update**
on the task board to choose an inclusive date range, review the changes grouped
by day, and copy a ready-to-share text update. Tasks created before status
history was added receive a one-time snapshot of their current status; future
transitions record the exact previous and next status. Imported snapshots stay
internal and are excluded from team updates, so reports show only task additions
and actual status transitions.

Enable **Automatically link thread forks** in a task's details to keep its
thread family together. Codex forks are matched through their recorded parent
thread identifier. Claude Code forks are matched through the root message ID
preserved in their copied local histories. The tracker checks for new related
threads whenever it refreshes.

Completed tasks have an **Archive** action. Archiving keeps the task, status
history, thread names, thread identifiers, and pull requests in PostgreSQL, but
removes the task from the active board. Every available linked Codex session is
archived through the official `codex archive` command. Expand **Archived tasks**
to inspect the saved work, fork a linked Codex session, or unarchive the task;
unarchive restores the linked Codex sessions with `codex unarchive`, and the
task can be archived again later. Claude Code histories remain linked and
unchanged because Claude Code does not provide a matching archive command.

## Start the app

Install Node.js 22 or newer, pnpm, Docker Desktop, and the coding-agent CLIs you
want to track. Then install the JavaScript dependencies:

```sh
pnpm install
```

Before the first sandbox monitor, connect the tracker to the Vercel account:

```sh
pnpm feature-sessions:vercel-auth
```

The command opens Vercel's device authorization flow when needed, creates one
short smoke-test sandbox, and stops it. Alternatively, provide
`VERCEL_OIDC_TOKEN`, or provide `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and
`VERCEL_PROJECT_ID` together.

Codex noninteractive mode requires a direct OpenAI API key. The tracker reads
and deduplicates `OPENAI_API_KEYS`, `OPENAI_API_KEY`, and
`BETA_FEATURES_OPENAI_API_KEY` from an ignored `.env.local`, then rotates new
monitor runs across that compatible pool. It also retains a local fallback to
`../mono/pr-reviewer-saas/.env.local` for the original development setup. Set
`FEATURE_TRACKER_OPENAI_ENV_FILE` to use another file. Azure OpenAI and NVIDIA
keys are not included because they authenticate different provider endpoints.

To override the reviewer pool, export one key only in the tracker process as
`FEATURE_TRACKER_CODEX_API_KEY`:

```sh
FEATURE_TRACKER_CODEX_API_KEY=your_api_key pnpm feature-sessions
```

In both modes, Vercel injects the selected key at the network boundary. The key
is never placed in the sandbox environment, filesystem, tracker state, or
PostgreSQL.

Install and open Docker Desktop first. Then, from the repository root:

```sh
pnpm feature-sessions
```

Open [http://127.0.0.1:4737](http://127.0.0.1:4737).

The command starts a private PostgreSQL 16 container on `127.0.0.1:55432`
before starting the tracker. PostgreSQL stores its data in the named Docker
volume `feature_session_tracker_pg_data`. The data survives stopping the app,
stopping or recreating the container, restarting Docker Desktop, and restarting
the Mac.

Stop PostgreSQL without removing its data:

```sh
pnpm feature-sessions:db:stop
```

Do not use `docker compose down -v` or delete the named volume unless you intend
to erase the tracker database.

The server binds only to `127.0.0.1`. **Start Codex** uses the local Codex App
Server and opens the new task in the Codex desktop app. **Start Claude** uses the
macOS Terminal app; PR **Monitor** uses Vercel Sandbox. The tracker scans the
standard local thread-history directories:

- `~/.codex/sessions` and `~/.codex/archived_sessions`
- `~/.claude/projects`

Feature plans, task details, and thread links are stored in the local PostgreSQL
database. On the first database start, the tracker imports existing data from
`~/.feature-session-tracker/state.json` if the database is empty. The JSON file
is kept unchanged as a migration backup, but PostgreSQL becomes the source of
truth after the import. The app shows thread titles, timestamps, workspace
names, branches, and resume commands. It does not provide full transcript
content or send data to another service.

Use a different web port or PostgreSQL connection when needed:

```sh
FEATURE_TRACKER_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/database \
  node server.mjs --port 4740
```

The old file storage remains available as an emergency fallback:

```sh
node server.mjs --storage file
```

## Test

```sh
pnpm test
```
