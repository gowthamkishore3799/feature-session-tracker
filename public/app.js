const STATUS_COLUMNS = [
	{ id: "planned", label: "Planned" },
	{ id: "in_progress", label: "In progress" },
	{ id: "blocked", label: "Blocked" },
	{ id: "done", label: "Done" },
]
const MAX_LINKED_THREADS = 500
const MAX_PULL_REQUESTS_PER_LINK = 10
const MONITOR_ACTIVITY_KINDS = new Set([
	"command",
	"error",
	"message",
	"progress",
	"result",
	"status",
])
const SESSION_SIDEBAR_COLLAPSED_KEY =
	"feature-session-tracker:session-sidebar-collapsed"
const ARCHIVED_TASKS_OPEN_KEY = "feature-session-tracker:archived-tasks-open"

const model = {
	defaultWorkspace: "",
	features: [],
	scannedAt: null,
	sessions: [],
}

const monitorActivityCache = new Map()

const view = {
	archivedTasksOpen: localStorage.getItem(ARCHIVED_TASKS_OPEN_KEY) === "true",
	provider: "all",
	search: "",
	selectedFeatureId: localStorage.getItem("feature-session-tracker:feature"),
	selectedItemId: null,
	sessionSidebarCollapsed:
		localStorage.getItem(SESSION_SIDEBAR_COLLAPSED_KEY) === "true",
}

const elements = {
	addPullRequestButton: document.querySelector("#add-pull-request-button"),
	copyTeamUpdateButton: document.querySelector("#copy-team-update-button"),
	featureDialog: document.querySelector("#feature-dialog"),
	featureDialogTitle: document.querySelector("#feature-dialog-title"),
	featureForm: document.querySelector("#feature-form"),
	featureList: document.querySelector("#feature-list"),
	featureMain: document.querySelector("#feature-main"),
	initialItemsField: document.querySelector("#initial-items-field"),
	linkingContext: document.querySelector("#linking-context"),
	linkPullRequestsButton: document.querySelector("#link-pull-requests-button"),
	newFeatureButton: document.querySelector("#new-feature-button"),
	providerFilter: document.querySelector("#provider-filter"),
	prAgentDescription: document.querySelector("#pr-agent-description"),
	prAgentDialog: document.querySelector("#pr-agent-dialog"),
	prAgentForm: document.querySelector("#pr-agent-form"),
	prAgentResult: document.querySelector("#pr-agent-result"),
	prMonitorDescription: document.querySelector("#pr-monitor-description"),
	prMonitorDialog: document.querySelector("#pr-monitor-dialog"),
	prMonitorForm: document.querySelector("#pr-monitor-form"),
	prMonitorRuns: document.querySelector("#pr-monitor-runs"),
	prMonitorTarget: document.querySelector("#pr-monitor-target"),
	pullRequestDescription: document.querySelector("#pull-request-description"),
	pullRequestDialog: document.querySelector("#pull-request-dialog"),
	pullRequestFields: document.querySelector("#pull-request-fields"),
	pullRequestForm: document.querySelector("#pull-request-form"),
	refreshButton: document.querySelector("#refresh-button"),
	runPrAgentButton: document.querySelector("#run-pr-agent-button"),
	saveFeatureButton: document.querySelector("#save-feature-button"),
	sessionLaunchDescription: document.querySelector(
		"#session-launch-description",
	),
	sessionLaunchDialog: document.querySelector("#session-launch-dialog"),
	sessionLaunchDot: document.querySelector("#session-launch-dot"),
	sessionLaunchForm: document.querySelector("#session-launch-form"),
	sessionLaunchNote: document.querySelector("#session-launch-note"),
	sessionLaunchProvider: document.querySelector("#session-launch-provider"),
	sessionLaunchTitle: document.querySelector("#session-launch-title"),
	sessionSidebar: document.querySelector("#session-sidebar"),
	sessionSidebarToggle: document.querySelector("#session-sidebar-toggle"),
	sessionSidebarToggleIcon: document.querySelector(
		"#session-sidebar-toggle-icon",
	),
	sessionCount: document.querySelector("#session-count"),
	sessionList: document.querySelector("#session-list"),
	sessionSearch: document.querySelector("#session-search"),
	syncStatus: document.querySelector("#sync-status"),
	startSessionButton: document.querySelector("#start-session-button"),
	startPrMonitorButton: document.querySelector("#start-pr-monitor-button"),
	taskArchiveButton: document.querySelector("#task-archive-button"),
	taskAddDialog: document.querySelector("#task-add-dialog"),
	taskAddForm: document.querySelector("#task-add-form"),
	taskDetailDialog: document.querySelector("#task-detail-dialog"),
	taskDetailForm: document.querySelector("#task-detail-form"),
	taskPrList: document.querySelector("#task-pr-list"),
	taskThreadList: document.querySelector("#task-thread-list"),
	teamUpdateDialog: document.querySelector("#team-update-dialog"),
	teamUpdateForm: document.querySelector("#team-update-form"),
	teamUpdateFrom: document.querySelector("#team-update-from"),
	teamUpdateList: document.querySelector("#team-update-list"),
	teamUpdateSummary: document.querySelector("#team-update-summary"),
	teamUpdateTo: document.querySelector("#team-update-to"),
	toast: document.querySelector("#toast"),
	workspace: document.querySelector("#workspace"),
}

function renderSessionSidebarState() {
	const collapsed = view.sessionSidebarCollapsed
	const label = collapsed ? "Expand agent threads" : "Collapse agent threads"
	elements.workspace.classList.toggle("is-session-sidebar-collapsed", collapsed)
	elements.sessionSidebar.classList.toggle("is-collapsed", collapsed)
	elements.sessionSidebarToggle.setAttribute(
		"aria-expanded",
		String(!collapsed),
	)
	elements.sessionSidebarToggle.setAttribute("aria-label", label)
	elements.sessionSidebarToggle.title = label
	elements.sessionSidebarToggleIcon.textContent = collapsed ? "‹" : "›"
}

function setSessionSidebarCollapsed(collapsed) {
	view.sessionSidebarCollapsed = collapsed
	localStorage.setItem(SESSION_SIDEBAR_COLLAPSED_KEY, String(collapsed))
	renderSessionSidebarState()
}

function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;")
}

function selectedFeature() {
	return model.features.find(feature => feature.id === view.selectedFeatureId)
}

function selectedItem() {
	return selectedFeature()?.workItems.find(
		item => item.id === view.selectedItemId,
	)
}

function progressFor(feature) {
	const total = feature.workItems.length
	const done = feature.workItems.filter(item => item.status === "done").length
	return { done, percent: total ? Math.round((done / total) * 100) : 0, total }
}

function relativeTime(timestamp) {
	const value = new Date(timestamp).getTime()
	if (!Number.isFinite(value)) return "Unknown time"
	const seconds = Math.round((value - Date.now()) / 1000)
	const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
	if (Math.abs(seconds) < 60) return formatter.format(seconds, "second")
	const minutes = Math.round(seconds / 60)
	if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute")
	const hours = Math.round(minutes / 60)
	if (Math.abs(hours) < 24) return formatter.format(hours, "hour")
	const days = Math.round(hours / 24)
	if (Math.abs(days) < 30) return formatter.format(days, "day")
	return new Intl.DateTimeFormat(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	}).format(new Date(timestamp))
}

function statusLabel(status) {
	return STATUS_COLUMNS.find(column => column.id === status)?.label ?? status
}

function dateInputValue(date) {
	const year = date.getFullYear()
	const month = String(date.getMonth() + 1).padStart(2, "0")
	const day = String(date.getDate()).padStart(2, "0")
	return `${year}-${month}-${day}`
}

function localDateFromInput(value) {
	const [year, month, day] = String(value).split("-").map(Number)
	if (![year, month, day].every(Number.isInteger)) return null
	const date = new Date(year, month - 1, day)
	return dateInputValue(date) === value ? date : null
}

function mondayFor(date) {
	const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate())
	const day = monday.getDay()
	monday.setDate(monday.getDate() - (day === 0 ? 6 : day - 1))
	return monday
}

function formattedDate(date, options = {}) {
	return new Intl.DateTimeFormat(undefined, {
		day: "numeric",
		month: "short",
		...options,
	}).format(date)
}

function teamUpdateEntries() {
	const feature = selectedFeature()
	const from = localDateFromInput(elements.teamUpdateFrom.value)
	const through = localDateFromInput(elements.teamUpdateTo.value)
	if (!feature || !from || !through || from > through) return []
	const endExclusive = new Date(through)
	endExclusive.setDate(endExclusive.getDate() + 1)
	return feature.workItems
		.flatMap(item => (item.statusHistory ?? []).map(entry => ({ entry, item })))
		.filter(({ entry }) => {
			if (entry.source === "snapshot") return false
			const timestamp = new Date(entry.changedAt)
			return timestamp >= from && timestamp < endExclusive
		})
		.sort(
			(left, right) =>
				new Date(left.entry.changedAt).getTime() -
				new Date(right.entry.changedAt).getTime(),
		)
}

function statusChangeDescription(entry) {
	if (!entry.from) {
		return entry.source === "created"
			? `Added as ${statusLabel(entry.to)}`
			: `Status recorded as ${statusLabel(entry.to)}`
	}
	return `Moved from ${statusLabel(entry.from)} to ${statusLabel(entry.to)}`
}

function renderTeamUpdate() {
	const from = localDateFromInput(elements.teamUpdateFrom.value)
	const through = localDateFromInput(elements.teamUpdateTo.value)
	if (!from || !through || from > through) {
		elements.teamUpdateSummary.innerHTML =
			'<span class="team-update-error">Choose a valid date range.</span>'
		elements.teamUpdateList.innerHTML = ""
		elements.copyTeamUpdateButton.disabled = true
		return
	}

	const entries = teamUpdateEntries()
	const range = `${formattedDate(from)} – ${formattedDate(through)}`
	elements.teamUpdateSummary.innerHTML = `<strong>${entries.length}</strong> ${
		entries.length === 1 ? "update" : "updates"
	} <span>${escapeHtml(range)}</span>`
	elements.copyTeamUpdateButton.disabled = entries.length === 0
	if (entries.length === 0) {
		elements.teamUpdateList.innerHTML = `
			<div class="team-update-empty">
				<strong>No changes</strong>
				<span>Choose another date range, add a task, or update a task status.</span>
			</div>`
		return
	}

	const groups = new Map()
	for (const update of entries) {
		const key = dateInputValue(new Date(update.entry.changedAt))
		if (!groups.has(key)) groups.set(key, [])
		groups.get(key).push(update)
	}
	elements.teamUpdateList.innerHTML = [...groups.entries()]
		.map(([date, updates]) => {
			const heading = formattedDate(localDateFromInput(date), {
				weekday: "long",
			})
			return `<section class="team-update-day">
				<h3>${escapeHtml(heading)}</h3>
				${updates
					.map(
						({ entry, item }) => `<div class="team-update-entry">
							<span class="status-marker status-${escapeHtml(entry.to)}"></span>
							<div>
								<strong>${escapeHtml(item.title)}</strong>
								<span>${escapeHtml(statusChangeDescription(entry))} · ${escapeHtml(
									new Intl.DateTimeFormat(undefined, {
										hour: "numeric",
										minute: "2-digit",
									}).format(new Date(entry.changedAt)),
								)}</span>
							</div>
						</div>`,
					)
					.join("")}
			</section>`
		})
		.join("")
}

function teamUpdateText() {
	const feature = selectedFeature()
	const from = localDateFromInput(elements.teamUpdateFrom.value)
	const through = localDateFromInput(elements.teamUpdateTo.value)
	if (!feature || !from || !through) return ""
	const entries = teamUpdateEntries()
	const lines = [
		`${feature.title} team update`,
		`${formattedDate(from)} – ${formattedDate(through)}`,
		"",
	]
	let previousDate = ""
	for (const { entry, item } of entries) {
		const date = dateInputValue(new Date(entry.changedAt))
		if (date !== previousDate) {
			if (previousDate) lines.push("")
			lines.push(formattedDate(localDateFromInput(date), { weekday: "long" }))
			previousDate = date
		}
		lines.push(`• ${item.title} — ${statusChangeDescription(entry)}`)
	}
	return lines.join("\n")
}

function notify(message, kind = "success") {
	elements.toast.textContent = message
	elements.toast.dataset.kind = kind
	elements.toast.classList.add("is-visible")
	window.clearTimeout(notify.timeout)
	notify.timeout = window.setTimeout(() => {
		elements.toast.classList.remove("is-visible")
	}, 2600)
}

async function api(path, options = {}) {
	const { timeoutMs = 0, ...fetchOptions } = options
	const mutation = options.method && options.method !== "GET"
	const controller = timeoutMs > 0 ? new AbortController() : null
	const timer = controller
		? window.setTimeout(() => controller.abort(), timeoutMs)
		: null
	try {
		const response = await fetch(path, {
			...fetchOptions,
			headers: {
				...(mutation
					? {
							"Content-Type": "application/json",
							"X-Feature-Tracker": "1",
						}
					: {}),
				...fetchOptions.headers,
			},
			signal: controller?.signal,
		})
		const result = await response.json()
		if (!response.ok) throw new Error(result.error || "Request failed")
		return result
	} catch (error) {
		if (controller?.signal.aborted) {
			throw new Error("Terminal did not open within 10 seconds. Try again.")
		}
		throw error
	} finally {
		if (timer != null) window.clearTimeout(timer)
	}
}

function ensureSelection() {
	if (!selectedFeature()) {
		view.selectedFeatureId = model.features[0]?.id ?? null
		view.selectedItemId = null
	}
	if (view.selectedFeatureId) {
		localStorage.setItem(
			"feature-session-tracker:feature",
			view.selectedFeatureId,
		)
	} else {
		localStorage.removeItem("feature-session-tracker:feature")
	}
	if (view.selectedItemId && !selectedItem()) view.selectedItemId = null
}

function linkedItemsForSession(sessionId) {
	return model.features.flatMap(feature =>
		feature.workItems
			.filter(item => item.sessionIds.includes(sessionId))
			.map(item => ({ feature, item })),
	)
}

function renderFeatureList() {
	if (model.features.length === 0) {
		elements.featureList.innerHTML = `
			<div class="sidebar-empty">
				<p>No features yet</p>
				<button class="text-button" data-action="new-feature" type="button">Create your first feature</button>
			</div>`
		return
	}

	elements.featureList.innerHTML = model.features
		.map(feature => {
			const progress = progressFor(feature)
			return `
				<button class="feature-list-item ${
					feature.id === view.selectedFeatureId ? "is-selected" : ""
				}" data-action="select-feature" data-feature-id="${escapeHtml(feature.id)}" type="button">
					<span class="feature-list-title">${escapeHtml(feature.title)}</span>
					<span class="feature-list-meta">
						<span>${progress.done}/${progress.total} done</span>
						<span>${progress.percent}%</span>
					</span>
					<span class="mini-progress"><span style="width:${progress.percent}%"></span></span>
				</button>`
		})
		.join("")
}

function agentOptions(agent) {
	return [
		["either", "Any agent"],
		["codex", "Codex"],
		["claude", "Claude Code"],
	]
		.map(
			([value, label]) =>
				`<option value="${value}" ${agent === value ? "selected" : ""}>${label}</option>`,
		)
		.join("")
}

function statusOptions(status) {
	return STATUS_COLUMNS.map(
		column =>
			`<option value="${column.id}" ${status === column.id ? "selected" : ""}>${column.label}</option>`,
	).join("")
}

function priorityLabel(priority) {
	return priority === "high" ? "High" : priority === "low" ? "Low" : "Medium"
}

function expandedRelatedSessionIds(seedIds) {
	const relatedIds = new Set(seedIds)
	const availableIds = new Set(model.sessions.map(session => session.id))
	let changed = true
	while (changed) {
		changed = false
		const activeClaudeGroups = new Set(
			model.sessions
				.filter(session => session.relatedGroupId && relatedIds.has(session.id))
				.map(session => session.relatedGroupId),
		)
		for (const session of model.sessions) {
			if (
				session.relatedGroupId &&
				activeClaudeGroups.has(session.relatedGroupId) &&
				!relatedIds.has(session.id)
			) {
				relatedIds.add(session.id)
				changed = true
			}
			if (!session.forkedFromId) continue
			const parentId = `${session.provider}:${session.forkedFromId}`
			if (relatedIds.has(parentId) && !relatedIds.has(session.id)) {
				relatedIds.add(session.id)
				changed = true
			}
			if (
				relatedIds.has(session.id) &&
				availableIds.has(parentId) &&
				!relatedIds.has(parentId)
			) {
				relatedIds.add(parentId)
				changed = true
			}
		}
	}
	return [...relatedIds].slice(0, MAX_LINKED_THREADS)
}

function threadDisplayName(item, sessionId, session) {
	return (
		item.sessionNames?.[sessionId] || session?.title || "Unavailable thread"
	)
}

function renderLinkedSessions(item) {
	if (item.sessionIds.length === 0) {
		return '<span class="no-session-label">No threads linked</span>'
	}
	const visibleSessionIds = item.sessionIds.slice(0, 3)
	const remainingCount = item.sessionIds.length - visibleSessionIds.length
	return `${visibleSessionIds
		.map(sessionId => {
			const session = model.sessions.find(
				candidate => candidate.id === sessionId,
			)
			const provider = session?.provider ?? sessionId.split(":")[0]
			const displayName = threadDisplayName(item, sessionId, session)
			const originalTitle = session?.title ?? sessionId
			return `<span class="linked-session ${provider}">
				<span class="provider-dot ${provider}"></span>
				<span title="${escapeHtml(originalTitle)}">${escapeHtml(displayName)}</span>
				${session?.isFork ? '<span class="fork-label">Fork</span>' : ""}
				<button data-action="unlink-session" data-session-id="${escapeHtml(
					sessionId,
				)}" data-item-id="${escapeHtml(item.id)}" type="button" aria-label="Unlink thread">×</button>
			</span>`
		})
		.join("")}${
		remainingCount > 0
			? `<button class="more-thread-button" data-action="open-task" data-item-id="${escapeHtml(
					item.id,
				)}" type="button">+${remainingCount} more ${remainingCount === 1 ? "thread" : "threads"}</button>`
			: ""
	}`
}

function renderPullRequestLinks(item, { editable = false, limit = 3 } = {}) {
	const pullRequests = item.pullRequests ?? []
	if (pullRequests.length === 0) {
		return editable
			? '<p class="task-thread-empty">No pull requests linked yet.</p>'
			: ""
	}
	const visiblePullRequests = pullRequests.slice(0, limit)
	const remainingCount = pullRequests.length - visiblePullRequests.length
	return `${visiblePullRequests
		.map(pullRequest => {
			const status = pullRequest.agent?.lastCheck?.status
			const latestMonitorRun = pullRequest.agent?.monitorRuns?.at(-1)
			const monitorLabel =
				latestMonitorRun?.status === "running"
					? "Running"
					: latestMonitorRun
						? "Activity"
						: "Monitor"
			const agentLabel = status
				? status === "healthy"
					? "Healthy"
					: status === "attention"
						? "Attention"
						: status === "pending"
							? "Pending"
							: "Unavailable"
				: "Check"
			return `<div class="linked-pr-row">
				<a class="linked-pr" data-action="open-pr" href="${escapeHtml(
					pullRequest.url,
				)}" target="_blank" rel="noreferrer" title="${escapeHtml(pullRequest.url)}">
					<span>PR</span>
					<strong>${escapeHtml(pullRequest.label)}</strong>
				</a>
				<button class="pr-agent-button ${status ? `status-${escapeHtml(status)}` : ""}" data-action="open-pr-agent" data-pr-id="${escapeHtml(
					pullRequest.id,
				)}" data-item-id="${escapeHtml(item.id)}" type="button" title="Open the PR agent">${escapeHtml(agentLabel)}</button>
				<button class="pr-monitor-button ${latestMonitorRun ? `status-${escapeHtml(latestMonitorRun.status)}` : ""}" data-action="open-pr-monitor" data-pr-id="${escapeHtml(
					pullRequest.id,
				)}" data-item-id="${escapeHtml(item.id)}" type="button" title="View agent activity or start a monitor">${monitorLabel}</button>
				${
					editable
						? `<button class="pr-unlink-button" data-action="unlink-pr" data-pr-id="${escapeHtml(
								pullRequest.id,
							)}" data-item-id="${escapeHtml(item.id)}" type="button" aria-label="Unlink ${escapeHtml(
								pullRequest.label,
							)}">×</button>`
						: ""
				}
			</div>`
		})
		.join("")}${
		remainingCount > 0
			? `<button class="more-thread-button" data-action="open-task" data-item-id="${escapeHtml(
					item.id,
				)}" type="button">+${remainingCount} more ${remainingCount === 1 ? "PR" : "PRs"}</button>`
			: ""
	}`
}

function renderWorkItem(item) {
	const agentClass = item.agent === "either" ? "neutral" : item.agent
	const priority = item.priority ?? "medium"
	const threadCount = item.sessionIds.length
	const pullRequestCount = (item.pullRequests ?? []).length
	const pendingLaunches = item.pendingLaunches ?? []
	return `
		<article class="work-card ${
			item.id === view.selectedItemId ? "is-selected" : ""
		}" data-action="select-item" data-item-id="${escapeHtml(item.id)}" tabindex="0">
			<div class="work-card-topline">
				<div class="task-badges">
					<span class="priority-pill ${priority}">${priorityLabel(priority)}</span>
					<span class="agent-pill ${agentClass}">${
						item.agent === "either"
							? "Any agent"
							: item.agent === "codex"
								? "Codex"
								: "Claude Code"
					}</span>
					${item.autoLinkForks ? '<span class="automation-pill">Auto forks</span>' : ""}
				</div>
				<div class="task-card-actions">
					${
						item.status === "done"
							? `<button class="card-archive" data-action="archive-item" data-item-id="${escapeHtml(
									item.id,
								)}" type="button">Archive</button>`
							: ""
					}
					<button class="card-detail" data-action="open-task" data-item-id="${escapeHtml(
						item.id,
					)}" type="button">Details</button>
					<button class="card-delete" data-action="delete-item" data-item-id="${escapeHtml(
						item.id,
					)}" type="button" aria-label="Delete ${escapeHtml(item.title)}" title="Delete task">×</button>
				</div>
			</div>
			<h4>${escapeHtml(item.title)}</h4>
			${item.notes ? `<p class="task-notes">${escapeHtml(item.notes)}</p>` : ""}
			<p class="thread-count">${threadCount} ${threadCount === 1 ? "thread" : "threads"} linked · ${pullRequestCount} ${pullRequestCount === 1 ? "PR" : "PRs"}</p>
			${pendingLaunches
				.map(
					launch => `<div class="session-starting ${escapeHtml(launch.provider)}">
						<span class="provider-dot ${escapeHtml(launch.provider)}"></span>
						<span>Starting ${launch.provider === "codex" ? "Codex" : "Claude Code"}</span>
					</div>`,
				)
				.join("")}
			<div class="linked-session-list">${renderLinkedSessions(item)}</div>
			<div class="linked-pr-list">${renderPullRequestLinks(item)}</div>
			<div class="work-card-controls">
				<label>
					<span class="sr-only">Status</span>
					<select data-action="update-status" data-item-id="${escapeHtml(item.id)}">${statusOptions(
						item.status,
					)}</select>
				</label>
				<label>
					<span class="sr-only">Preferred agent</span>
					<select data-action="update-agent" data-item-id="${escapeHtml(item.id)}">${agentOptions(
						item.agent,
					)}</select>
				</label>
			</div>
			<div class="task-launch-actions">
				<button class="launch-session-button codex" data-action="open-session-launch" data-provider="codex" data-item-id="${escapeHtml(
					item.id,
				)}" type="button">Start Codex</button>
				<button class="launch-session-button claude" data-action="open-session-launch" data-provider="claude" data-item-id="${escapeHtml(
					item.id,
				)}" type="button">Start Claude</button>
				<button class="link-thread-button" data-action="focus-thread-linker" data-item-id="${escapeHtml(
					item.id,
				)}" type="button">Link existing</button>
				<button class="link-pr-button" data-action="open-pr-dialog" data-item-id="${escapeHtml(
					item.id,
				)}" type="button">Link PR</button>
			</div>
		</article>`
}

function renderArchivedWorkItem(item) {
	const threadCount = item.sessionIds.length
	const pullRequestCount = (item.pullRequests ?? []).length
	return `<article class="archived-task-row">
		<div class="archived-task-copy">
			<span>Archived ${escapeHtml(relativeTime(item.archivedAt))}</span>
			<strong>${escapeHtml(item.title)}</strong>
			<small>${threadCount} ${threadCount === 1 ? "thread" : "threads"} · ${pullRequestCount} ${pullRequestCount === 1 ? "PR" : "PRs"} retained</small>
		</div>
		<div class="archived-task-actions">
			<button class="button button-secondary" data-action="open-task" data-item-id="${escapeHtml(
				item.id,
			)}" type="button">Details</button>
			<button class="button button-secondary" data-action="unarchive-item" data-item-id="${escapeHtml(
				item.id,
			)}" type="button">Unarchive</button>
		</div>
	</article>`
}

function renderMain() {
	const feature = selectedFeature()
	if (!feature) {
		elements.featureMain.innerHTML = `
			<section class="main-empty">
				<div class="empty-illustration" aria-hidden="true">
					<span></span><span></span><span></span>
				</div>
				<p class="eyebrow">A home for agent-assisted work</p>
				<h1>Turn a feature into visible progress</h1>
				<p>Create a feature, split it into tasks, then attach every Codex and Claude Code thread that moves it forward.</p>
				<button class="button button-primary" data-action="new-feature" type="button">Create feature</button>
			</section>`
		return
	}

	const progress = progressFor(feature)
	const activeWorkItems = feature.workItems.filter(item => !item.archivedAt)
	const archivedWorkItems = feature.workItems.filter(item => item.archivedAt)
	elements.featureMain.innerHTML = `
		<section class="feature-header">
			<div class="feature-heading-copy">
				<div class="feature-title-row">
					<div>
						<p class="eyebrow">Current feature</p>
						<h1>${escapeHtml(feature.title)}</h1>
					</div>
					<div class="feature-actions">
						<button class="button button-secondary" data-action="edit-feature" type="button">Edit</button>
						<button class="button button-secondary danger-text" data-action="delete-feature" type="button">Delete</button>
					</div>
				</div>
				${
					feature.description
						? `<p class="feature-description">${escapeHtml(feature.description)}</p>`
						: '<p class="feature-description is-empty">Add an outcome so the finish line stays clear.</p>'
				}
			</div>
			<div class="feature-progress-card">
				<div class="progress-ring" style="--progress:${progress.percent * 3.6}deg">
					<span>${progress.percent}%</span>
				</div>
				<div>
					<strong>${progress.done} of ${progress.total}</strong>
					<span>tasks complete</span>
				</div>
			</div>
		</section>
		<section class="board-toolbar">
			<div>
				<h2>Task board</h2>
				<p>Track each task and keep every related agent thread attached.</p>
			</div>
			<div class="board-toolbar-actions">
				<button class="button button-secondary" data-action="open-team-update" type="button">Team update</button>
				<button class="button button-primary" data-action="add-items" type="button">Add tasks</button>
			</div>
		</section>
		<section class="board" aria-label="Feature tasks">
			${STATUS_COLUMNS.map(column => {
				const items = activeWorkItems.filter(item => item.status === column.id)
				return `
					<section class="board-column status-${column.id}">
						<header>
							<div><span class="status-marker"></span><h3>${column.label}</h3></div>
							<span class="column-count">${items.length}</span>
						</header>
						<div class="column-items">
							${
								items.length
									? items.map(renderWorkItem).join("")
									: `<button class="column-empty" data-action="add-items" type="button">Add a task</button>`
							}
						</div>
					</section>`
			}).join("")}
		</section>
		${
			archivedWorkItems.length
				? `<details class="archived-tasks" data-archived-tasks ${view.archivedTasksOpen ? "open" : ""}>
					<summary>
						<span>Archived tasks</span>
						<span class="column-count">${archivedWorkItems.length}</span>
					</summary>
					<div class="archived-task-list">${archivedWorkItems
						.map(renderArchivedWorkItem)
						.join("")}</div>
				</details>`
				: ""
		}`
}

function renderSessionList() {
	const query = view.search.toLocaleLowerCase()
	const filtered = model.sessions.filter(session => {
		if (view.provider !== "all" && session.provider !== view.provider)
			return false
		if (!query) return true
		return [
			session.title,
			...(session.titleAliases ?? []),
			session.workspace,
			session.branch,
			session.sessionId,
		]
			.join(" ")
			.toLocaleLowerCase()
			.includes(query)
	})
	const item = selectedItem()
	const feature = selectedFeature()
	const linkableItems = feature?.workItems.filter(
		candidate => !candidate.archivedAt,
	)
	const linkTarget = item?.archivedAt ? null : item
	elements.sessionCount.textContent = String(model.sessions.length)
	elements.linkingContext.innerHTML = linkableItems?.length
		? `<label class="linking-picker">
			<span>Link threads to</span>
			<select data-action="select-link-target" aria-label="Task to link threads to">
				<option value="">Choose a task</option>
				${linkableItems
					.map(
						candidate =>
							`<option value="${escapeHtml(candidate.id)}" ${candidate.id === linkTarget?.id ? "selected" : ""}>${escapeHtml(candidate.title)}</option>`,
					)
					.join("")}
			</select>
			<small>${linkTarget ? "Choose a thread below." : "Select an active task before linking a thread."}</small>
		</label>`
		: `<div class="linking-hint">Add or unarchive a task before linking a thread.</div>`

	if (filtered.length === 0) {
		elements.sessionList.innerHTML = `
			<div class="session-empty">
				<strong>No matching threads</strong>
				<span>Try another search or refresh the scan.</span>
			</div>`
		return
	}

	elements.sessionList.innerHTML = filtered
		.slice(0, 100)
		.map(session => {
			const links = linkedItemsForSession(session.id)
			const linkedToSelected = Boolean(
				linkTarget?.sessionIds.includes(session.id),
			)
			return `
				<article class="session-card ${session.activity === "active" ? "is-active" : ""}">
					<div class="session-card-header">
						<div class="session-source">
							<span class="provider-label ${session.provider}">
								<span class="provider-dot ${session.provider}"></span>
								${session.provider === "codex" ? "Codex" : "Claude Code"}
							</span>
							${session.isFork ? '<span class="session-fork-label">Fork</span>' : ""}
						</div>
						<span class="session-time"><span class="activity-dot ${session.activity}"></span>${escapeHtml(
							relativeTime(session.updatedAt),
						)}</span>
					</div>
					<h3 title="${escapeHtml(session.title)}">${escapeHtml(session.title)}</h3>
					<div class="session-metadata" title="${escapeHtml(session.cwd)}">
						<span>${escapeHtml(session.workspace)}</span>
						${session.branch ? `<span>${escapeHtml(session.branch)}</span>` : ""}
						${session.archived ? "<span>Archived</span>" : ""}
					</div>
					${
						links.length
							? `<p class="session-linked-note">Linked to ${links.length} ${links.length === 1 ? "task" : "tasks"}</p>`
							: ""
					}
					<div class="session-actions">
						<button class="small-button" data-action="copy-resume" data-command="${escapeHtml(
							session.resumeCommand,
						)}" type="button">Copy resume</button>
						<button class="small-button primary ${linkedToSelected ? "is-linked" : ""}" data-action="link-session" data-session-id="${escapeHtml(
							session.id,
						)}" type="button" ${linkTarget && !linkedToSelected ? "" : "disabled"}>
							${linkedToSelected ? "Linked" : "Link thread"}
						</button>
					</div>
				</article>`
		})
		.join("")
}

function render() {
	ensureSelection()
	renderSessionSidebarState()
	renderFeatureList()
	renderMain()
	renderSessionList()
	if (elements.taskDetailDialog.open) renderTaskDialogThreads()
	if (elements.taskDetailDialog.open) renderTaskDialogPullRequests()
	if (elements.teamUpdateDialog.open) renderTeamUpdate()
	if (elements.prMonitorDialog.open) {
		const feature = selectedFeature()
		const item = feature?.workItems.find(
			candidate => candidate.id === elements.prMonitorForm.dataset.itemId,
		)
		const pullRequest = item?.pullRequests?.find(
			candidate => candidate.id === elements.prMonitorForm.dataset.prId,
		)
		if (item && pullRequest) renderPrMonitorRuns(item, pullRequest)
	}
}

async function refresh({ force = false, quiet = false } = {}) {
	if (!quiet) {
		elements.refreshButton.disabled = true
		elements.syncStatus.innerHTML =
			'<span class="sync-dot is-scanning"></span><span>Scanning threads</span>'
	}
	try {
		const data = await api(`/api/bootstrap${force ? "?refresh=1" : ""}`)
		model.defaultWorkspace = data.defaultWorkspace ?? model.defaultWorkspace
		model.features = data.features
		model.sessions = data.sessions
		model.scannedAt = data.scannedAt
		render()
		if (data.autoLinkedCount > 0) {
			notify(
				`${data.autoLinkedCount} related ${data.autoLinkedCount === 1 ? "thread" : "threads"} linked`,
			)
		}
		if (data.launchedLinkedCount > 0) {
			notify(
				`${data.launchedLinkedCount} new ${data.launchedLinkedCount === 1 ? "session" : "sessions"} linked`,
			)
		}
		if (data.pullRequestsLinkedCount > 0) {
			notify(
				`${data.pullRequestsLinkedCount} pull ${data.pullRequestsLinkedCount === 1 ? "request" : "requests"} linked from agent sessions`,
			)
		}
		elements.syncStatus.innerHTML = `<span class="sync-dot"></span><span>Updated ${escapeHtml(
			relativeTime(data.scannedAt),
		)}</span>`
	} catch (error) {
		elements.syncStatus.innerHTML =
			'<span class="sync-dot has-error"></span><span>Scan needs attention</span>'
		if (!quiet) notify(error.message, "error")
	} finally {
		elements.refreshButton.disabled = false
	}
}

async function mutate(path, method, body, successMessage) {
	try {
		const data = await api(path, {
			body: JSON.stringify(body ?? {}),
			method,
		})
		model.features = data.features
		render()
		if (successMessage) notify(successMessage)
		return data
	} catch (error) {
		notify(error.message, "error")
		throw error
	}
}

async function changeTaskArchiveState(feature, item, archived) {
	if (
		archived &&
		!window.confirm(
			`Archive “${item.title}”? Its linked Codex sessions will move to the Codex archive. All task, thread, Claude Code, and pull request links will stay saved here.`,
		)
	) {
		return
	}
	try {
		const data = await api(
			`/api/features/${encodeURIComponent(feature.id)}/items/${encodeURIComponent(item.id)}/${archived ? "archive" : "unarchive"}`,
			{ body: "{}", method: "POST" },
		)
		model.features = data.features
		if (elements.taskDetailDialog.open) elements.taskDetailDialog.close()
		if (archived && view.selectedItemId === item.id) view.selectedItemId = null
		render()
		await refresh({ force: true, quiet: true })
		const changed = data.result.codexSessionsChanged
		const unavailable = data.result.unavailableCodexSessions
		const codexDetail = changed
			? ` · ${changed} Codex ${changed === 1 ? "session" : "sessions"} ${archived ? "archived" : "restored"}`
			: ""
		const unavailableDetail = unavailable
			? ` · ${unavailable} unavailable Codex ${unavailable === 1 ? "session was" : "sessions were"} unchanged`
			: ""
		notify(
			`Task ${archived ? "archived" : "unarchived"}${codexDetail}${unavailableDetail}`,
		)
	} catch (error) {
		notify(error.message, "error")
		throw error
	}
}

function openFeatureDialog(feature = null) {
	elements.featureForm.reset()
	elements.featureForm.dataset.featureId = feature?.id ?? ""
	elements.featureDialogTitle.textContent = feature
		? "Edit feature"
		: "Create feature"
	elements.saveFeatureButton.textContent = feature
		? "Save changes"
		: "Create feature"
	elements.initialItemsField.hidden = Boolean(feature)
	if (feature) {
		elements.featureForm.elements.title.value = feature.title
		elements.featureForm.elements.description.value = feature.description
	}
	elements.featureDialog.showModal()
	window.setTimeout(() => elements.featureForm.elements.title.focus(), 0)
}

function openTeamUpdateDialog() {
	const today = new Date()
	elements.teamUpdateFrom.value = dateInputValue(mondayFor(today))
	elements.teamUpdateTo.value = dateInputValue(today)
	renderTeamUpdate()
	elements.teamUpdateDialog.showModal()
	window.setTimeout(() => elements.teamUpdateFrom.focus(), 0)
}

function taskForDetailDialog() {
	const feature = selectedFeature()
	return feature?.workItems.find(
		item => item.id === elements.taskDetailForm.dataset.itemId,
	)
}

function pullRequestForAgent() {
	const feature = selectedFeature()
	const item = feature?.workItems.find(
		candidate => candidate.id === elements.prAgentForm.dataset.itemId,
	)
	const pullRequest = item?.pullRequests?.find(
		candidate => candidate.id === elements.prAgentForm.dataset.prId,
	)
	return { feature, item, pullRequest }
}

function prAgentStatusLabel(status) {
	return (
		{
			attention: "Needs attention",
			healthy: "Healthy",
			not_configured: "Not configured",
			pending: "Pending",
			ready: "Ready",
			unavailable: "Unavailable",
			unsupported: "Unsupported",
		}[status] ?? "Unknown"
	)
}

function renderPrAgentResult() {
	const { pullRequest } = pullRequestForAgent()
	const snapshot = pullRequest?.agent?.lastCheck
	if (!snapshot) {
		elements.prAgentResult.innerHTML = `<div class="pr-agent-empty">
			<strong>No check has run yet</strong>
			<span>Run it when you want a fresh GitHub and deployment snapshot.</span>
		</div>`
		return
	}
	const github = snapshot.github ?? {}
	const checks = github.checks ?? {}
	const gcp = snapshot.gcp ?? {}
	const deployment = gcp.deployment
	const logs = gcp.logs
	const githubDetails = github.error
		? `<p class="pr-agent-error">${escapeHtml(github.error)}</p>`
		: `<dl class="pr-agent-facts">
			<div><dt>State</dt><dd>${escapeHtml(github.state || "Unknown")}${github.isDraft ? " · Draft" : ""}</dd></div>
			<div><dt>Reviews</dt><dd>${escapeHtml(github.reviewDecision || "No decision")}</dd></div>
			<div><dt>Checks</dt><dd>${Number(checks.passing) || 0} passing · ${Number(checks.pending) || 0} pending · ${Number(checks.failing) || 0} failing</dd></div>
		</dl>
		${checks.failingNames?.length ? `<p class="pr-agent-detail"><strong>Failing:</strong> ${escapeHtml(checks.failingNames.join(", "))}</p>` : ""}
		${checks.pendingNames?.length ? `<p class="pr-agent-detail"><strong>Pending:</strong> ${escapeHtml(checks.pendingNames.join(", "))}</p>` : ""}`
	let gcpDetails = `<p class="pr-agent-muted">Add all three Cloud Run fields above to inspect a deployment.</p>`
	if (gcp.error) {
		gcpDetails = `<p class="pr-agent-error">${escapeHtml(gcp.error)}</p>`
	} else if (deployment) {
		gcpDetails = `<dl class="pr-agent-facts">
			<div><dt>Service</dt><dd>${escapeHtml(gcp.target?.service ?? "")}</dd></div>
			<div><dt>Ready revision</dt><dd>${escapeHtml(deployment.latestReadyRevision || "Waiting for a ready revision")}</dd></div>
			<div><dt>Deployment</dt><dd>${escapeHtml(prAgentStatusLabel(deployment.status))}</dd></div>
		</dl>`
		if (logs) {
			gcpDetails += `<div class="pr-agent-log-filter">
				<div><strong>Logs Explorer filter</strong><span>${escapeHtml(formattedDate(new Date(logs.windowStart), { hour: "numeric", minute: "2-digit" }))} – ${escapeHtml(formattedDate(new Date(logs.windowEnd), { hour: "numeric", minute: "2-digit" }))}</span></div>
				<code>${escapeHtml(logs.filter)}</code>
				<button class="small-button" data-action="copy-log-filter" data-filter="${escapeHtml(logs.filter)}" type="button">Copy filter</button>
			</div>
			${
				logs.entries?.length
					? `<div class="pr-agent-logs"><strong>${logs.entries.length} error ${logs.entries.length === 1 ? "entry" : "entries"}</strong>${logs.entries
							.map(
								entry =>
									`<div><span>${escapeHtml(entry.severity)} · ${escapeHtml(relativeTime(entry.timestamp))}</span><p>${escapeHtml(entry.message)}</p></div>`,
							)
							.join("")}</div>`
					: '<p class="pr-agent-success">No ERROR logs found for this ready revision in the checked window.</p>'
			}`
		}
	}
	elements.prAgentResult.innerHTML = `
		<div class="pr-agent-result-heading">
			<div><strong>Latest check</strong><span>${escapeHtml(relativeTime(snapshot.checkedAt))}</span></div>
			<span class="pr-agent-status status-${escapeHtml(snapshot.status)}">${escapeHtml(prAgentStatusLabel(snapshot.status))}</span>
		</div>
		<section class="pr-agent-section">
			<div class="pr-agent-section-heading"><h3>GitHub</h3><span class="pr-agent-status status-${escapeHtml(github.status)}">${escapeHtml(prAgentStatusLabel(github.status))}</span></div>
			${githubDetails}
		</section>
		<section class="pr-agent-section">
			<div class="pr-agent-section-heading"><h3>Cloud Run & logs</h3><span class="pr-agent-status status-${escapeHtml(gcp.status)}">${escapeHtml(prAgentStatusLabel(gcp.status))}</span></div>
			${gcpDetails}
		</section>`
}

function openPrAgentDialog(item, pullRequest) {
	elements.prAgentForm.dataset.itemId = item.id
	elements.prAgentForm.dataset.prId = pullRequest.id
	elements.prAgentDescription.textContent = pullRequest.label
	const target = pullRequest.agent?.gcpTarget ?? {}
	elements.prAgentForm.elements.project.value = target.project ?? ""
	elements.prAgentForm.elements.region.value = target.region ?? ""
	elements.prAgentForm.elements.service.value = target.service ?? ""
	renderPrAgentResult()
	if (elements.taskDetailDialog.open) elements.taskDetailDialog.close()
	elements.prAgentDialog.showModal()
	window.setTimeout(() => elements.runPrAgentButton.focus(), 0)
}

function monitorActivityCacheKey(item, pullRequest, run) {
	return `${item.id}:${pullRequest.id}:${run.id}`
}

function monitorRunStatusLabel(status) {
	return (
		{
			blocked: "Blocked",
			failed: "Failed",
			healthy: "Healthy",
			issue: "Issue found",
			pending: "Pending",
			running: "Running",
		}[status] ?? "Unknown"
	)
}

function monitorActivityPrompt(kind) {
	return (
		{
			command: "$",
			error: "!",
			message: "•",
			progress: "›",
			result: "✓",
			status: "›",
		}[kind] ?? "›"
	)
}

function renderPrMonitorRuns(item, pullRequest) {
	const runs = pullRequest.agent?.monitorRuns ?? []
	if (runs.length === 0) {
		elements.prMonitorRuns.innerHTML =
			'<p class="pr-monitor-activity-empty">Start a monitor to see its activity here.</p>'
		return
	}
	const latestRun = runs.at(-1)
	elements.prMonitorRuns.innerHTML = [...runs]
		.reverse()
		.map((run, index) => {
			const cached = monitorActivityCache.get(
				monitorActivityCacheKey(item, pullRequest, run),
			)
			const retainedActivity = run.activity ?? []
			const activity = retainedActivity.length
				? retainedActivity
				: (cached?.activity ?? [])
			const activityMarkup = activity.length
				? `<ol class="pr-monitor-activity-list">${activity
						.map(entry => {
							const kind = MONITOR_ACTIVITY_KINDS.has(entry.kind)
								? entry.kind
								: "status"
							return `<li class="kind-${kind}">
								<span class="pr-monitor-activity-prompt" aria-hidden="true">${monitorActivityPrompt(kind)}</span>
								<div><strong>${escapeHtml(entry.title)}</strong>${entry.detail ? `<pre>${escapeHtml(entry.detail)}</pre>` : ""}</div>
							</li>`
						})
						.join("")}</ol>`
				: `<p class="pr-monitor-activity-empty">${escapeHtml(
						cached?.error ||
							(cached?.loading
								? "Loading agent activity…"
								: "Activity has not been loaded for this run."),
					)}</p>`
			const canRefresh = retainedActivity.length === 0
			const statusLabel = monitorRunStatusLabel(run.status)
			return `<details class="pr-monitor-run" ${run === latestRun || index === 0 ? "open" : ""}>
				<summary>
					<span class="pr-monitor-run-status status-${escapeHtml(run.status)}">${escapeHtml(statusLabel)}</span>
					<span class="pr-monitor-run-title"><strong>Monitor run</strong><small>${escapeHtml(relativeTime(run.startedAt))}</small></span>
					<span class="pr-monitor-run-summary">${escapeHtml(run.summary || run.error || `${activity.length} activity ${activity.length === 1 ? "event" : "events"}`)}</span>
				</summary>
				<div class="pr-monitor-run-body">
					<div class="pr-monitor-terminal">
						<div class="pr-monitor-terminal-bar">
							<span class="pr-monitor-terminal-lights" aria-hidden="true"><span></span><span></span><span></span></span>
							<span class="pr-monitor-terminal-title">codex monitor</span>
							<span class="pr-monitor-terminal-status status-${escapeHtml(run.status)}">${escapeHtml(statusLabel)}</span>
						</div>
						<div class="pr-monitor-terminal-output" role="log" aria-label="Codex monitor activity" aria-live="polite">
							${run.summary ? `<div class="pr-monitor-terminal-notice kind-result"><span aria-hidden="true">✓</span><div><strong>Monitor summary</strong><p>${escapeHtml(run.summary)}</p></div></div>` : ""}
							${run.error ? `<div class="pr-monitor-terminal-notice kind-error"><span aria-hidden="true">!</span><div><strong>Monitor error</strong><p>${escapeHtml(run.error)}</p></div></div>` : ""}
							${activityMarkup}
						</div>
						<div class="pr-monitor-run-footer">
							<code>${escapeHtml(run.sandboxId)}</code>
							${canRefresh ? `<button class="small-button" data-action="refresh-monitor-activity" data-item-id="${escapeHtml(item.id)}" data-pr-id="${escapeHtml(pullRequest.id)}" data-run-id="${escapeHtml(run.id)}" type="button" ${cached?.loading ? "disabled" : ""}>${cached?.loading ? "Loading…" : activity.length ? "Refresh activity" : "Load activity"}</button>` : "<span>Activity retained</span>"}
						</div>
					</div>
				</div>
			</details>`
		})
		.join("")
}

async function loadMonitorActivity(
	feature,
	item,
	pullRequest,
	run,
	force = false,
) {
	const key = monitorActivityCacheKey(item, pullRequest, run)
	const cached = monitorActivityCache.get(key)
	if (cached?.loading || (!force && (run.activity?.length || cached))) return
	monitorActivityCache.set(key, { ...(cached ?? {}), loading: true })
	if (elements.prMonitorDialog.open) renderPrMonitorRuns(item, pullRequest)
	try {
		const result = await api(
			`/api/features/${encodeURIComponent(feature.id)}/items/${encodeURIComponent(item.id)}/pull-requests/${encodeURIComponent(pullRequest.id)}/monitor-runs/${encodeURIComponent(run.id)}/activity`,
			{ body: "{}", method: "POST", timeoutMs: 35_000 },
		)
		monitorActivityCache.set(key, {
			activity: result.activity ?? [],
			loadedAt: Date.now(),
			loading: false,
		})
	} catch (error) {
		monitorActivityCache.set(key, {
			activity: cached?.activity ?? [],
			error: error.message,
			loadedAt: Date.now(),
			loading: false,
		})
	} finally {
		if (elements.prMonitorDialog.open) renderPrMonitorRuns(item, pullRequest)
	}
}

function openPrMonitorDialog(item, pullRequest) {
	elements.prMonitorForm.reset()
	elements.prMonitorForm.dataset.itemId = item.id
	elements.prMonitorForm.dataset.prId = pullRequest.id
	elements.prMonitorDescription.textContent = pullRequest.label
	elements.prMonitorForm.elements.workspacePath.value =
		item.workspacePath || model.defaultWorkspace
	elements.prMonitorForm.elements.instructions.value =
		"Monitor this PR through deployment. Alert me about failed required checks, review blockers, deployment failures, or new ERROR logs."
	const target = pullRequest.agent?.gcpTarget
	const sandboxRuns = pullRequest.agent?.monitorRuns ?? []
	const legacyMonitorCount = pullRequest.agent?.monitorSessionIds?.length ?? 0
	const monitorCount = sandboxRuns.length + legacyMonitorCount
	const latestRun = sandboxRuns.at(-1)
	const latestRunSummary = latestRun
		? `<small>Latest sandbox: ${escapeHtml(latestRun.status)} · ${escapeHtml(relativeTime(latestRun.startedAt))}</small>`
		: ""
	elements.prMonitorTarget.innerHTML = target
		? `<strong>Deployment target</strong><span>${escapeHtml(target.project)} · ${escapeHtml(target.region)} · ${escapeHtml(target.service)}</span>${monitorCount ? `<small>${monitorCount} monitor ${monitorCount === 1 ? "run" : "runs"} stored</small>` : ""}${latestRunSummary}`
		: `<strong>GitHub-only monitor</strong><span>Configure Cloud Run in the PR check panel to also check deployment readiness and logs.</span>${monitorCount ? `<small>${monitorCount} monitor ${monitorCount === 1 ? "run" : "runs"} stored</small>` : ""}${latestRunSummary}`
	renderPrMonitorRuns(item, pullRequest)
	if (elements.taskDetailDialog.open) elements.taskDetailDialog.close()
	elements.prMonitorDialog.showModal()
	if (latestRun && !latestRun.activity?.length) {
		void loadMonitorActivity(selectedFeature(), item, pullRequest, latestRun)
	}
	window.setTimeout(
		() => elements.prMonitorForm.elements.instructions.focus(),
		0,
	)
}

function renderTaskDialogThreads() {
	const item = taskForDetailDialog()
	if (!item) {
		elements.taskThreadList.innerHTML =
			'<p class="task-thread-empty">This task is no longer available.</p>'
		return
	}
	elements.taskThreadList.innerHTML = item.sessionIds.length
		? item.sessionIds
				.map(sessionId => {
					const session = model.sessions.find(
						candidate => candidate.id === sessionId,
					)
					const provider = session?.provider ?? sessionId.split(":")[0]
					const providerLabel = provider === "codex" ? "Codex" : "Claude Code"
					return `<div class="task-thread-editor">
						<div class="task-thread-editor-meta">
							<span class="provider-label ${provider}"><span class="provider-dot ${provider}"></span>${providerLabel}</span>
							${session?.isFork ? '<span class="fork-label">Related fork</span>' : ""}
							${session?.archived ? '<span class="thread-archive-label">Archived</span>' : ""}
						</div>
						<input
							aria-label="Custom name for ${providerLabel} thread"
							data-thread-name
							data-session-id="${escapeHtml(sessionId)}"
							maxlength="100"
							placeholder="${escapeHtml(session?.title ?? sessionId)}"
							value="${escapeHtml(item.sessionNames?.[sessionId] ?? "")}"
						/>
						<div class="task-thread-editor-actions">
							${
								provider === "codex"
									? `<button data-action="fork-session" data-session-id="${escapeHtml(
											sessionId,
										)}" data-item-id="${escapeHtml(item.id)}" type="button">Fork</button>`
									: ""
							}
							<button class="thread-unlink-button" data-action="unlink-session" data-session-id="${escapeHtml(
								sessionId,
							)}" data-item-id="${escapeHtml(item.id)}" type="button" aria-label="Unlink ${providerLabel} thread">×</button>
						</div>
					</div>`
				})
				.join("")
		: '<p class="task-thread-empty">No threads linked yet.</p>'
}

function renderTaskDialogPullRequests() {
	const item = taskForDetailDialog()
	elements.taskPrList.innerHTML = item
		? renderPullRequestLinks(item, { editable: true, limit: 100 })
		: '<p class="task-thread-empty">This task is no longer available.</p>'
}

function pullRequestFormEntries() {
	return [
		...elements.pullRequestFields.querySelectorAll("[data-pr-entry]"),
	].map(entry => ({
		label: entry.querySelector("[data-pr-label]").value,
		url: entry.querySelector("[data-pr-url]").value,
	}))
}

function renderPullRequestFields(entries = [{ label: "", url: "" }]) {
	elements.pullRequestFields.innerHTML = entries
		.map(
			(entry, index) => `<div class="pull-request-entry" data-pr-entry>
				<div class="pull-request-entry-heading">
					<strong>${entries.length === 1 ? "Pull request" : `Pull request ${index + 1}`}</strong>
					${
						entries.length > 1
							? `<button class="pull-request-remove-button" data-action="remove-pr-entry" data-index="${index}" type="button" aria-label="Remove pull request ${index + 1}">×</button>`
							: ""
					}
				</div>
				<label class="field">
					<span>Pull request URL</span>
					<input
						data-pr-url
						type="url"
						maxlength="2048"
						required
						placeholder="https://github.com/owner/repository/pull/123"
						value="${escapeHtml(entry.url)}"
					/>
				</label>
				<label class="field">
					<span>Name <small>Optional</small></span>
					<input
						data-pr-label
						maxlength="160"
						placeholder="Example: Add product heat tabs"
						value="${escapeHtml(entry.label)}"
					/>
				</label>
			</div>`,
		)
		.join("")
	elements.addPullRequestButton.disabled =
		entries.length >= MAX_PULL_REQUESTS_PER_LINK
	elements.linkPullRequestsButton.textContent =
		entries.length === 1 ? "Link PR" : `Link ${entries.length} PRs`
}

function openTaskDetailDialog(item) {
	view.selectedItemId = item.id
	elements.taskDetailForm.dataset.itemId = item.id
	elements.taskDetailForm.elements.title.value = item.title
	elements.taskDetailForm.elements.notes.value = item.notes ?? ""
	elements.taskDetailForm.elements.status.value = item.status
	elements.taskDetailForm.elements.priority.value = item.priority ?? "medium"
	elements.taskDetailForm.elements.agent.value = item.agent
	elements.taskDetailForm.elements.workspacePath.value =
		item.workspacePath || model.defaultWorkspace
	elements.taskDetailForm.elements.autoLinkForks.checked =
		item.autoLinkForks === true
	elements.taskArchiveButton.hidden = item.status !== "done" && !item.archivedAt
	elements.taskArchiveButton.dataset.action = item.archivedAt
		? "unarchive-item"
		: "archive-item"
	elements.taskArchiveButton.dataset.itemId = item.id
	elements.taskArchiveButton.textContent = item.archivedAt
		? "Unarchive task"
		: "Archive task"
	render()
	renderTaskDialogThreads()
	renderTaskDialogPullRequests()
	elements.taskDetailDialog.showModal()
	window.setTimeout(() => elements.taskDetailForm.elements.title.focus(), 0)
}

function openPullRequestDialog(item) {
	view.selectedItemId = item.id
	elements.pullRequestForm.reset()
	renderPullRequestFields()
	elements.pullRequestForm.dataset.itemId = item.id
	elements.pullRequestDescription.textContent = item.title
	if (elements.taskDetailDialog.open) elements.taskDetailDialog.close()
	renderMain()
	renderSessionList()
	elements.pullRequestDialog.showModal()
	window.setTimeout(
		() => elements.pullRequestFields.querySelector("[data-pr-url]").focus(),
		0,
	)
}

function openSessionLaunchDialog(item, provider) {
	view.selectedItemId = item.id
	elements.sessionLaunchForm.reset()
	elements.sessionLaunchForm.dataset.itemId = item.id
	elements.sessionLaunchForm.dataset.provider = provider
	const providerLabel = provider === "codex" ? "Codex" : "Claude Code"
	elements.sessionLaunchProvider.textContent = providerLabel
	elements.sessionLaunchTitle.textContent = `Start ${providerLabel}`
	elements.sessionLaunchDescription.textContent = item.title
	elements.sessionLaunchDot.className = `provider-dot ${provider}`
	elements.sessionLaunchNote.textContent =
		provider === "codex"
			? "A new task opens in the Codex app and links here automatically."
			: "Terminal opens on this Mac. The new thread links here automatically."
	elements.sessionLaunchForm.elements.workspacePath.value =
		item.workspacePath || model.defaultWorkspace
	elements.sessionLaunchForm.elements.context.value = item.notes ?? ""
	elements.startSessionButton.textContent =
		provider === "codex" ? "Create in Codex" : `Start ${providerLabel}`
	elements.sessionLaunchDialog.showModal()
	window.setTimeout(
		() => elements.sessionLaunchForm.elements.workspacePath.focus(),
		0,
	)
}

function taskById(itemId) {
	return model.features
		.flatMap(feature => feature.workItems)
		.find(item => item.id === itemId)
}

async function watchLaunchedSession(itemId, launchId) {
	for (let attempt = 0; attempt < 8; attempt += 1) {
		await new Promise(resolve => window.setTimeout(resolve, 2_500))
		await refresh({ force: true, quiet: true })
		const item = taskById(itemId)
		if (!item?.pendingLaunches?.some(launch => launch.id === launchId)) return
	}
}

function focusThreadLinker(itemId) {
	setSessionSidebarCollapsed(false)
	view.selectedItemId = itemId
	view.search = ""
	view.provider = "all"
	elements.sessionSearch.value = ""
	for (const candidate of elements.providerFilter.querySelectorAll(
		"[data-provider]",
	)) {
		candidate.classList.toggle(
			"is-active",
			candidate.dataset.provider === "all",
		)
	}
	if (elements.taskDetailDialog.open) elements.taskDetailDialog.close()
	renderMain()
	renderSessionList()
	window.setTimeout(() => {
		elements.linkingContext.scrollIntoView({
			behavior: "smooth",
			block: "start",
		})
		elements.sessionSearch.focus()
	}, 0)
}

function splitWorkItems(value) {
	return value
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
}

elements.newFeatureButton.addEventListener("click", () => openFeatureDialog())
elements.refreshButton.addEventListener("click", () => refresh({ force: true }))
elements.addPullRequestButton.addEventListener("click", () => {
	const entries = pullRequestFormEntries()
	if (entries.length >= MAX_PULL_REQUESTS_PER_LINK) return
	renderPullRequestFields([...entries, { label: "", url: "" }])
	window.setTimeout(() => {
		const urlFields =
			elements.pullRequestFields.querySelectorAll("[data-pr-url]")
		urlFields[urlFields.length - 1].focus()
	}, 0)
})
elements.pullRequestFields.addEventListener("click", event => {
	const removeButton = event.target.closest('[data-action="remove-pr-entry"]')
	if (!removeButton) return
	const entries = pullRequestFormEntries()
	entries.splice(Number(removeButton.dataset.index), 1)
	renderPullRequestFields(entries)
})
elements.sessionSidebarToggle.addEventListener("click", () => {
	setSessionSidebarCollapsed(!view.sessionSidebarCollapsed)
})
elements.sessionSearch.addEventListener("input", event => {
	view.search = event.target.value
	renderSessionList()
})
elements.providerFilter.addEventListener("click", event => {
	const button = event.target.closest("[data-provider]")
	if (!button) return
	view.provider = button.dataset.provider
	for (const candidate of elements.providerFilter.querySelectorAll(
		"[data-provider]",
	)) {
		candidate.classList.toggle("is-active", candidate === button)
	}
	renderSessionList()
})
elements.teamUpdateForm.addEventListener("input", renderTeamUpdate)
elements.copyTeamUpdateButton.addEventListener("click", async () => {
	try {
		await navigator.clipboard.writeText(teamUpdateText())
		notify("Team update copied")
	} catch {
		notify("Unable to copy the team update", "error")
	}
})

elements.featureForm.addEventListener("submit", async event => {
	if (event.submitter?.value === "cancel") return
	event.preventDefault()
	const values = new FormData(elements.featureForm)
	const featureId = elements.featureForm.dataset.featureId
	const body = {
		description: values.get("description"),
		title: values.get("title"),
	}
	if (!featureId) body.workItems = splitWorkItems(values.get("workItems"))
	try {
		const data = await mutate(
			featureId
				? `/api/features/${encodeURIComponent(featureId)}`
				: "/api/features",
			featureId ? "PATCH" : "POST",
			body,
			featureId ? "Feature updated" : "Feature created",
		)
		if (!featureId) view.selectedFeatureId = data.result.id
		elements.featureDialog.close()
		render()
	} catch {
		// The error is announced by mutate and the dialog stays open.
	}
})

elements.taskAddForm.addEventListener("submit", async event => {
	if (event.submitter?.value === "cancel") return
	event.preventDefault()
	const feature = selectedFeature()
	if (!feature) return
	const values = new FormData(elements.taskAddForm)
	try {
		await mutate(
			`/api/features/${encodeURIComponent(feature.id)}/items`,
			"POST",
			{ titles: splitWorkItems(values.get("workItems")) },
			"Tasks added",
		)
		elements.taskAddDialog.close()
		elements.taskAddForm.reset()
	} catch {
		// The error is announced by mutate and the dialog stays open.
	}
})

elements.taskDetailForm.addEventListener("submit", async event => {
	if (event.submitter?.value === "cancel") return
	event.preventDefault()
	const feature = selectedFeature()
	const item = taskForDetailDialog()
	if (!feature || !item) return
	const values = new FormData(elements.taskDetailForm)
	const sessionNames = Object.fromEntries(
		[...elements.taskThreadList.querySelectorAll("[data-thread-name]")]
			.map(input => [input.dataset.sessionId, input.value.trim()])
			.filter(([, name]) => name),
	)
	try {
		await mutate(
			`/api/features/${encodeURIComponent(feature.id)}/items/${encodeURIComponent(item.id)}`,
			"PATCH",
			{
				agent: values.get("agent"),
				autoLinkForks: values.get("autoLinkForks") === "on",
				notes: values.get("notes"),
				priority: values.get("priority"),
				sessionNames,
				status: values.get("status"),
				title: values.get("title"),
				workspacePath: values.get("workspacePath"),
			},
			"Task updated",
		)
		if (values.get("autoLinkForks") === "on") {
			await refresh({ force: true, quiet: true })
		}
		elements.taskDetailDialog.close()
	} catch {
		// The error is announced by mutate and the dialog stays open.
	}
})

elements.pullRequestForm.addEventListener("submit", async event => {
	if (event.submitter?.value === "cancel") return
	event.preventDefault()
	const feature = selectedFeature()
	const item = feature?.workItems.find(
		candidate => candidate.id === elements.pullRequestForm.dataset.itemId,
	)
	if (!feature || !item) return
	const entries = pullRequestFormEntries()
	const linkedUrls = new Set(
		(item.pullRequests ?? []).map(pullRequest => pullRequest.url),
	)
	const pullRequests = []
	for (const [index, entry] of entries.entries()) {
		let url
		try {
			const candidate = new URL(entry.url.trim())
			if (!["http:", "https:"].includes(candidate.protocol)) throw new Error()
			url = candidate.toString()
		} catch {
			notify(`Enter a valid URL for pull request ${index + 1}`, "error")
			return
		}
		if (linkedUrls.has(url)) {
			notify(`Pull request ${index + 1} is already linked`, "error")
			return
		}
		linkedUrls.add(url)
		pullRequests.push({
			createdAt: new Date().toISOString(),
			id: crypto.randomUUID(),
			label: entry.label.trim(),
			url,
		})
	}
	try {
		await mutate(
			`/api/features/${encodeURIComponent(feature.id)}/items/${encodeURIComponent(item.id)}`,
			"PATCH",
			{
				pullRequests: [...(item.pullRequests ?? []), ...pullRequests],
			},
			pullRequests.length === 1
				? "Pull request linked"
				: `${pullRequests.length} pull requests linked`,
		)
		elements.pullRequestDialog.close()
	} catch {
		// The error is announced by mutate and the dialog stays open.
	}
})

elements.prAgentForm.addEventListener("submit", async event => {
	if (event.submitter?.value === "cancel") return
	event.preventDefault()
	const { feature, item, pullRequest } = pullRequestForAgent()
	if (!feature || !item || !pullRequest) return
	const values = new FormData(elements.prAgentForm)
	const target = {
		project: String(values.get("project") ?? "").trim(),
		region: String(values.get("region") ?? "").trim(),
		service: String(values.get("service") ?? "").trim(),
	}
	const gcpTarget = Object.values(target).some(Boolean) ? target : null
	elements.runPrAgentButton.disabled = true
	elements.runPrAgentButton.textContent = "Checking…"
	elements.prAgentResult.innerHTML =
		'<div class="pr-agent-empty is-checking"><strong>Checking this PR</strong><span>Reading GitHub, then the configured deployment and recent revision logs.</span></div>'
	try {
		await mutate(
			`/api/features/${encodeURIComponent(feature.id)}/items/${encodeURIComponent(item.id)}/pull-requests/${encodeURIComponent(pullRequest.id)}/check`,
			"POST",
			{ gcpTarget },
			"PR check complete",
		)
		renderPrAgentResult()
	} catch {
		renderPrAgentResult()
	} finally {
		elements.runPrAgentButton.disabled = false
		elements.runPrAgentButton.textContent = "Run check"
	}
})

elements.prMonitorForm.addEventListener("submit", async event => {
	if (event.submitter?.value === "cancel") return
	event.preventDefault()
	const feature = selectedFeature()
	const item = feature?.workItems.find(
		candidate => candidate.id === elements.prMonitorForm.dataset.itemId,
	)
	const pullRequest = item?.pullRequests?.find(
		candidate => candidate.id === elements.prMonitorForm.dataset.prId,
	)
	if (!feature || !item || !pullRequest) return
	const values = new FormData(elements.prMonitorForm)
	elements.startPrMonitorButton.disabled = true
	elements.startPrMonitorButton.textContent = "Creating sandbox…"
	try {
		const data = await api(
			`/api/features/${encodeURIComponent(feature.id)}/items/${encodeURIComponent(item.id)}/pull-requests/${encodeURIComponent(pullRequest.id)}/monitor`,
			{
				body: JSON.stringify({
					instructions: values.get("instructions"),
					workspacePath: values.get("workspacePath"),
				}),
				method: "POST",
				timeoutMs: 45_000,
			},
		)
		model.features = data.features
		render()
		const updatedItem = selectedFeature()?.workItems.find(
			candidate => candidate.id === item.id,
		)
		const updatedPullRequest = updatedItem?.pullRequests?.find(
			candidate => candidate.id === pullRequest.id,
		)
		const latestRun = updatedPullRequest?.agent?.monitorRuns?.at(-1)
		if (updatedItem && updatedPullRequest && latestRun) {
			void loadMonitorActivity(
				selectedFeature(),
				updatedItem,
				updatedPullRequest,
				latestRun,
				true,
			)
		}
		notify("Codex is running in your Vercel Sandbox")
	} catch (error) {
		notify(error.message, "error")
	} finally {
		elements.startPrMonitorButton.disabled = false
		elements.startPrMonitorButton.textContent = "Start in Sandbox"
	}
})

elements.sessionLaunchForm.addEventListener("submit", async event => {
	if (event.submitter?.value === "cancel") return
	event.preventDefault()
	const feature = selectedFeature()
	const itemId = elements.sessionLaunchForm.dataset.itemId
	const item = feature?.workItems.find(candidate => candidate.id === itemId)
	if (!feature || !item) return
	const provider = elements.sessionLaunchForm.dataset.provider
	const providerLabel = provider === "codex" ? "Codex" : "Claude Code"
	const values = new FormData(elements.sessionLaunchForm)
	elements.startSessionButton.disabled = true
	elements.startSessionButton.textContent = "Starting session"
	try {
		const data = await api(
			`/api/features/${encodeURIComponent(feature.id)}/items/${encodeURIComponent(item.id)}/launch`,
			{
				body: JSON.stringify({
					context: values.get("context"),
					provider,
					workspacePath: values.get("workspacePath"),
				}),
				method: "POST",
			},
		)
		model.features = data.features
		elements.sessionLaunchDialog.close()
		render()
		notify(
			provider === "codex"
				? "Codex app task created"
				: `${providerLabel} session opened`,
		)
		watchLaunchedSession(item.id, data.result.launchId)
	} catch (error) {
		notify(error.message, "error")
	} finally {
		elements.startSessionButton.disabled = false
		elements.startSessionButton.textContent =
			provider === "codex" ? "Create in Codex" : `Start ${providerLabel}`
	}
})

document.addEventListener("click", async event => {
	const target = event.target.closest("[data-action]")
	if (!target) return
	const action = target.dataset.action
	const feature = selectedFeature()

	if (action === "new-feature") {
		openFeatureDialog()
		return
	}
	if (action === "select-feature") {
		view.selectedFeatureId = target.dataset.featureId
		view.selectedItemId = null
		render()
		return
	}
	if (action === "select-item") {
		view.selectedItemId = target.dataset.itemId
		renderMain()
		renderSessionList()
		return
	}
	if (action === "open-task" && feature) {
		event.stopPropagation()
		const item = feature.workItems.find(
			candidate => candidate.id === target.dataset.itemId,
		)
		if (item) openTaskDetailDialog(item)
		return
	}
	if (action === "open-pr") return
	if (action === "open-pr-agent" && feature) {
		event.stopPropagation()
		const item = feature.workItems.find(
			candidate => candidate.id === target.dataset.itemId,
		)
		const pullRequest = item?.pullRequests?.find(
			candidate => candidate.id === target.dataset.prId,
		)
		if (item && pullRequest) openPrAgentDialog(item, pullRequest)
		return
	}
	if (action === "open-pr-monitor" && feature) {
		event.stopPropagation()
		const item = feature.workItems.find(
			candidate => candidate.id === target.dataset.itemId,
		)
		const pullRequest = item?.pullRequests?.find(
			candidate => candidate.id === target.dataset.prId,
		)
		if (item && pullRequest) openPrMonitorDialog(item, pullRequest)
		return
	}
	if (action === "refresh-monitor-activity" && feature) {
		event.stopPropagation()
		const item = feature.workItems.find(
			candidate => candidate.id === target.dataset.itemId,
		)
		const pullRequest = item?.pullRequests?.find(
			candidate => candidate.id === target.dataset.prId,
		)
		const run = pullRequest?.agent?.monitorRuns?.find(
			candidate => candidate.id === target.dataset.runId,
		)
		if (item && pullRequest && run) {
			await loadMonitorActivity(feature, item, pullRequest, run, true)
		}
		return
	}
	if (action === "open-pr-dialog" && feature) {
		event.stopPropagation()
		const itemId =
			target.dataset.itemId || elements.taskDetailForm.dataset.itemId
		const item = feature.workItems.find(candidate => candidate.id === itemId)
		if (item) openPullRequestDialog(item)
		return
	}
	if (action === "open-session-launch" && feature) {
		event.stopPropagation()
		const item = feature.workItems.find(
			candidate => candidate.id === target.dataset.itemId,
		)
		if (item) openSessionLaunchDialog(item, target.dataset.provider)
		return
	}
	if (action === "open-team-update" && feature) {
		openTeamUpdateDialog()
		return
	}
	if (action === "focus-thread-linker" && feature) {
		event.stopPropagation()
		const itemId =
			target.dataset.itemId || elements.taskDetailForm.dataset.itemId
		if (feature.workItems.some(item => item.id === itemId)) {
			focusThreadLinker(itemId)
		}
		return
	}
	if (action === "add-items") {
		elements.taskAddForm.reset()
		elements.taskAddDialog.showModal()
		window.setTimeout(() => elements.taskAddForm.elements.workItems.focus(), 0)
		return
	}
	if (action === "edit-feature" && feature) {
		openFeatureDialog(feature)
		return
	}
	if (action === "delete-feature" && feature) {
		if (!window.confirm(`Delete “${feature.title}” and its tasks?`)) return
		await mutate(
			`/api/features/${encodeURIComponent(feature.id)}`,
			"DELETE",
			{},
			"Feature deleted",
		)
		view.selectedFeatureId = model.features[0]?.id ?? null
		view.selectedItemId = null
		render()
		return
	}
	if (["archive-item", "unarchive-item"].includes(action) && feature) {
		event.stopPropagation()
		const item = feature.workItems.find(
			candidate => candidate.id === target.dataset.itemId,
		)
		if (!item) return
		target.disabled = true
		try {
			await changeTaskArchiveState(feature, item, action === "archive-item")
		} catch {
			// The failure is announced above and the task remains unchanged.
		} finally {
			target.disabled = false
		}
		return
	}
	if (action === "delete-item" && feature) {
		event.stopPropagation()
		const item = feature.workItems.find(
			candidate => candidate.id === target.dataset.itemId,
		)
		if (!item || !window.confirm(`Delete “${item.title}”?`)) return
		await mutate(
			`/api/features/${encodeURIComponent(feature.id)}/items/${encodeURIComponent(item.id)}`,
			"DELETE",
			{},
			"Task deleted",
		)
		if (view.selectedItemId === item.id) view.selectedItemId = null
		render()
		return
	}
	if (action === "fork-session" && feature) {
		event.stopPropagation()
		const item = feature.workItems.find(
			candidate => candidate.id === target.dataset.itemId,
		)
		if (!item) return
		target.disabled = true
		const originalLabel = target.textContent
		target.textContent = "Opening…"
		try {
			const data = await api(
				`/api/features/${encodeURIComponent(feature.id)}/items/${encodeURIComponent(item.id)}/sessions/${encodeURIComponent(target.dataset.sessionId)}/fork`,
				{ body: "{}", method: "POST" },
			)
			model.features = data.features
			render()
			notify("Codex fork opened and will stay linked to this task")
			watchLaunchedSession(item.id, data.result.launchId)
		} catch (error) {
			notify(error.message, "error")
		} finally {
			target.disabled = false
			target.textContent = originalLabel
		}
		return
	}
	if (action === "link-session" && feature) {
		const item = selectedItem()
		if (!item) return
		const selectedIds = [...item.sessionIds, target.dataset.sessionId]
		await mutate(
			`/api/features/${encodeURIComponent(feature.id)}/items/${encodeURIComponent(item.id)}`,
			"PATCH",
			{
				sessionIds: item.autoLinkForks
					? expandedRelatedSessionIds(selectedIds)
					: selectedIds,
			},
			"Thread linked",
		)
		return
	}
	if (action === "unlink-session" && feature) {
		event.stopPropagation()
		const item = feature.workItems.find(
			candidate => candidate.id === target.dataset.itemId,
		)
		if (!item) return
		await mutate(
			`/api/features/${encodeURIComponent(feature.id)}/items/${encodeURIComponent(item.id)}`,
			"PATCH",
			{
				sessionIds: item.sessionIds.filter(
					id => id !== target.dataset.sessionId,
				),
			},
			"Thread unlinked",
		)
		return
	}
	if (action === "unlink-pr" && feature) {
		event.stopPropagation()
		const item = feature.workItems.find(
			candidate => candidate.id === target.dataset.itemId,
		)
		if (!item) return
		await mutate(
			`/api/features/${encodeURIComponent(feature.id)}/items/${encodeURIComponent(item.id)}`,
			"PATCH",
			{
				pullRequests: (item.pullRequests ?? []).filter(
					pullRequest => pullRequest.id !== target.dataset.prId,
				),
			},
			"Pull request unlinked",
		)
		return
	}
	if (action === "copy-resume") {
		try {
			await navigator.clipboard.writeText(target.dataset.command)
			notify("Resume command copied")
		} catch {
			notify("Unable to copy the resume command", "error")
		}
		return
	}
	if (action === "copy-log-filter") {
		try {
			await navigator.clipboard.writeText(target.dataset.filter)
			notify("Logs Explorer filter copied")
		} catch {
			notify("Unable to copy the log filter", "error")
		}
	}
})

elements.linkingContext.addEventListener("change", event => {
	const picker = event.target.closest('[data-action="select-link-target"]')
	if (!picker) return
	view.selectedItemId = picker.value || null
	renderMain()
	renderSessionList()
})

document.addEventListener("change", async event => {
	const target = event.target.closest("[data-action]")
	const feature = selectedFeature()
	if (!target || !feature) return
	const item = feature.workItems.find(
		candidate => candidate.id === target.dataset.itemId,
	)
	if (!item) return
	if (target.dataset.action === "update-status") {
		await mutate(
			`/api/features/${encodeURIComponent(feature.id)}/items/${encodeURIComponent(item.id)}`,
			"PATCH",
			{ status: target.value },
			"Status updated",
		)
	}
	if (target.dataset.action === "update-agent") {
		await mutate(
			`/api/features/${encodeURIComponent(feature.id)}/items/${encodeURIComponent(item.id)}`,
			"PATCH",
			{ agent: target.value },
			"Agent preference updated",
		)
	}
})

document.addEventListener("keydown", event => {
	const card = event.target.closest('[data-action="select-item"]')
	if (!card || !["Enter", " "].includes(event.key)) return
	if (event.target.closest("button, select")) return
	event.preventDefault()
	view.selectedItemId = card.dataset.itemId
	renderMain()
	renderSessionList()
})

document.addEventListener(
	"toggle",
	event => {
		if (!event.target.matches("[data-archived-tasks]")) return
		view.archivedTasksOpen = event.target.open
		localStorage.setItem(
			ARCHIVED_TASKS_OPEN_KEY,
			String(view.archivedTasksOpen),
		)
	},
	true,
)

renderSessionSidebarState()
refresh()
window.setInterval(() => refresh({ force: true, quiet: true }), 20_000)
window.setInterval(() => {
	if (!elements.prMonitorDialog.open) return
	const feature = selectedFeature()
	const item = feature?.workItems.find(
		candidate => candidate.id === elements.prMonitorForm.dataset.itemId,
	)
	const pullRequest = item?.pullRequests?.find(
		candidate => candidate.id === elements.prMonitorForm.dataset.prId,
	)
	const latestRun = pullRequest?.agent?.monitorRuns?.at(-1)
	if (feature && item && pullRequest && latestRun?.status === "running") {
		void loadMonitorActivity(feature, item, pullRequest, latestRun, true)
	}
}, 3_000)
