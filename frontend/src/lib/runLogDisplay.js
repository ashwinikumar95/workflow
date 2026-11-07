const SKIP_KEYS = new Set([
  'analysis',
  'artifactDir',
  'description',
  'descriptionText',
  'fingerprint',
  'issueId',
  'jira',
  'plan',
  'profileKey',
  'prompt',
  'repoPath',
  'rulesApplied',
  'rulesManifest',
  'source',
  'worktreePath',
])

export function statusClass(status) {
  if (status === 'success') return 'ok'
  if (status === 'failed' || status === 'cancelled') return 'danger'
  if (status === 'waiting') return 'wait'
  if (status === 'interrupted') return 'interrupted'
  return 'muted'
}

function unescapeJsonString(value) {
  return value
    .replace(/\\n/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

function pickQuoted(text, key) {
  const match = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`))
  return match ? unescapeJsonString(match[1]) : ''
}

function extractFromPartialJson(text) {
  const out = {}
  const issueKey = pickQuoted(text, 'issueKey') || pickQuoted(text, 'key')
  const summary = pickQuoted(text, 'summary')
  const status = pickQuoted(text, 'status')
  const reason = pickQuoted(text, 'reason')
  const message = pickQuoted(text, 'message')
  const branch = pickQuoted(text, 'branch')
  const eventType = pickQuoted(text, 'eventType')
  const agentMode = pickQuoted(text, 'agentMode')
  if (issueKey) out.issueKey = issueKey
  if (summary) out.summary = summary
  if (status) out.status = status
  if (reason) out.reason = reason
  if (message) out.message = message
  if (branch) out.branch = branch
  if (eventType) out.eventType = eventType
  if (agentMode) out.agentMode = agentMode
  if (!Object.keys(out).length) out.preview = text.slice(0, 280)
  return out
}

export function coerceObject(value) {
  if (value == null || value === '') return null
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return { value: String(value) }
  const text = value.trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') return parsed
    return { value: parsed }
  } catch {
    return extractFromPartialJson(text)
  }
}

export function asPlan(plan) {
  if (!plan) return null
  if (typeof plan === 'string') {
    try {
      const parsed = JSON.parse(plan)
      return parsed && typeof parsed === 'object' ? parsed : { approach: plan }
    } catch {
      return { approach: plan }
    }
  }
  if (typeof plan === 'object') return plan
  return null
}

function pushFact(facts, label, value) {
  if (value == null || value === '') return
  const text = Array.isArray(value) ? value.filter(Boolean).join(', ') : String(value)
  if (!text.trim()) return
  facts.push({ label, value: text })
}

export function factsFrom(value) {
  const obj = coerceObject(value)
  if (!obj) return []
  const facts = []
  const jira = obj.jira && typeof obj.jira === 'object' ? obj.jira : {}
  pushFact(facts, 'Ticket', obj.issueKey || jira.key)
  pushFact(facts, 'Summary', obj.summary || jira.summary)
  pushFact(facts, 'Jira status', jira.status)
  if (obj.branch === true || obj.branch === 'true') pushFact(facts, 'Result', 'Passed')
  else if (obj.branch === false || obj.branch === 'false') pushFact(facts, 'Result', 'Failed')
  pushFact(facts, 'Reason', humanReason(obj.reason) || obj.reason)
  pushFact(facts, 'Message', obj.message)
  pushFact(facts, 'Event', obj.eventType)
  pushFact(facts, 'Mode', obj.agentMode)
  const plan = asPlan(obj.plan)
  if (plan) {
    pushFact(facts, 'Plan', plan.approach)
    if (Array.isArray(plan.filesToChange)) pushFact(facts, 'Files', plan.filesToChange)
  }
  pushFact(facts, 'Pull request', obj.prUrl)
  if (typeof obj.prompt === 'string' && obj.prompt.trim()) {
    const prompt = obj.prompt.trim()
    pushFact(facts, 'Prompt', prompt.length > 180 ? `${prompt.slice(0, 180)}…` : prompt)
  }
  if (obj.guardFailed) pushFact(facts, 'Guard', 'Commit/push guard failed')
  if (obj._notifySkipped) pushFact(facts, 'Notify', 'Slack skipped')
  if (obj.value !== undefined) pushFact(facts, 'Value', obj.value)
  if (obj.preview && facts.length === 0) pushFact(facts, 'Preview', obj.preview)

  if (facts.length === 0 && !Array.isArray(obj)) {
    for (const [key, val] of Object.entries(obj)) {
      if (SKIP_KEYS.has(key) || val == null || typeof val === 'object') continue
      pushFact(facts, key, val)
    }
  }
  return facts
}

export function mergeFacts(outputFacts, inputFacts) {
  const seen = new Set()
  const merged = []
  for (const fact of [...outputFacts, ...inputFacts]) {
    if (seen.has(fact.label)) continue
    seen.add(fact.label)
    merged.push(fact)
  }
  return merged
}

export function ticketFromContext(context) {
  if (!context || typeof context !== 'object') return null
  const jira = context.jira && typeof context.jira === 'object' ? context.jira : {}
  const issueKey = typeof context.issueKey === 'string' ? context.issueKey : jira.key
  const summary = jira.summary || context.summary
  if (!issueKey && !summary) return null
  return {
    issueKey: issueKey || '',
    summary: summary || '',
    status: jira.status || '',
  }
}

export function rawPreview(value) {
  if (value == null || value === '') return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function promptFromContext(context) {
  if (!context || typeof context !== 'object') return ''
  return typeof context.prompt === 'string' && context.prompt.trim() ? context.prompt : ''
}

export function waitingKind(run) {
  return run && run.wait && typeof run.wait.kind === 'string' ? run.wait.kind : ''
}

export function isApprovalWait(run) {
  if (!run || run.status !== 'waiting') return false
  const kind = waitingKind(run)
  return !kind || kind === 'approval'
}

export function isResuming(run) {
  return Boolean(
    run &&
      run.status === 'waiting' &&
      run.wait &&
      run.wait.state === 'completing' &&
      run.approval &&
      run.approval.decision
  )
}

export function waitingTitle(run) {
  if (run && run.context && run.context.rulesReviewWait) return 'Approve rules review'
  if (asPlan(run && run.context && run.context.plan)) return 'Approve this plan'
  if (promptFromContext(run && run.context)) return 'Approve this Cursor prompt'
  return 'Waiting for approval'
}

const STOP_NODE = /Failed$|Rejected$|^notifyGate$|^notifyEnv$/

export function humanReason(reason) {
  if (reason == null || reason === '') return ''
  const key = String(reason)
  const map = {
    'plan-dirty': 'The plan agent changed the worktree or HEAD. The plan must leave git clean.',
    invalid_plan: 'The plan file was missing or was not valid JSON.',
    invalid_result: 'The agent result file was missing or invalid.',
    invalid_review: 'The rules review output was invalid.',
    env: 'Commit/push guard failed (credentials or environment files).',
  }
  return map[key] || key
}

export function formatLogRaw(value) {
  if (value == null || value === '') return ''
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }
  const text = String(value)
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

function stopMessage(logs) {
  const ids = (logs || []).map((row) => row.nodeId || '')
  if (ids.some((id) => /PlanFailed/.test(id))) return 'Plan did not stay clean'
  if (ids.some((id) => /Rejected/.test(id))) return 'Plan was rejected'
  if (ids.some((id) => /AgentFailed/.test(id))) return 'Implementation did not produce a clean commit'
  if (ids.some((id) => id === 'notifyGate')) return 'Rules, lint, or build still failing'
  if (ids.some((id) => id === 'notifyEnv')) return 'Environment or credentials failed'
  return 'Run stopped'
}

function outcomeTitle(logs, ctx) {
  const ids = (logs || []).map((row) => row.nodeId || '')
  if (ids.some((id) => /PlanFailed/.test(id)) || ctx.reason === 'plan-dirty' || ctx.reason === 'invalid_plan') {
    return 'Plan failed'
  }
  if (ids.some((id) => /Rejected/.test(id))) return 'Plan rejected'
  if (ids.some((id) => /AgentFailed/.test(id))) return 'Implementation failed'
  return 'Run failed'
}

export function displayRunStatus(run) {
  if (!run) return { status: '', className: 'muted', label: '', reason: '', title: '' }
  const stored = run.status
  const ctx = run.context && typeof run.context === 'object' ? run.context : {}
  const logs = Array.isArray(run.logs) ? run.logs : []
  if (stored !== 'success') {
    return {
      status: stored,
      className: statusClass(stored),
      label: stored,
      title: stored === 'failed' ? outcomeTitle(logs, ctx) : '',
      reason: humanReason(ctx.reason),
    }
  }
  const hitStop = logs.some((log) => STOP_NODE.test(log.nodeId || ''))
  const branchFailed = ctx.branch === 'false' || ctx.branch === false
  if (hitStop || branchFailed || ctx.reason || ctx.guardFailed) {
    return {
      status: 'failed',
      className: 'danger',
      label: 'failed',
      title: outcomeTitle(logs, ctx),
      reason: humanReason(ctx.reason) || stopMessage(logs),
    }
  }
  return { status: 'success', className: 'ok', label: 'success', reason: '', title: '' }
}

export function displayLogStatus(log, run) {
  const stored = log && log.status ? log.status : ''
  if (stored === 'waiting' || stored === 'failed' || stored === 'cancelled') {
    return { status: stored, className: statusClass(stored), label: stored }
  }
  const nodeId = (log && log.nodeId) || ''
  const out = coerceObject(log && log.output) || {}
  const branchFailed = out.branch === 'false' || out.branch === false
  const planFailedLater = (run && Array.isArray(run.logs) ? run.logs : []).some((row) =>
    /PlanFailed/.test(row.nodeId || '')
  )
  const agentPlanFailed = nodeId === 'agentPlan' && stored === 'success' && planFailedLater
  if (STOP_NODE.test(nodeId) || branchFailed || agentPlanFailed) {
    return { status: 'failed', className: 'danger', label: 'failed' }
  }
  return { status: stored, className: statusClass(stored), label: stored || 'step' }
}

export function enrichLogFacts(log, run) {
  let facts = mergeFacts(factsFrom(log && log.output), factsFrom(log && log.input))
  const ctx = run && run.context && typeof run.context === 'object' ? run.context : {}
  const jira = ctx.jira && typeof ctx.jira === 'object' ? ctx.jira : {}
  const nodeId = (log && log.nodeId) || ''
  const planFailed = (run && Array.isArray(run.logs) ? run.logs : []).some((row) =>
    /PlanFailed/.test(row.nodeId || '')
  )

  const has = (label) => facts.some((fact) => fact.label === label)
  const add = (label, value) => {
    if (value == null || value === '' || has(label)) return
    facts = [...facts, { label, value: String(value) }]
  }

  if (nodeId === 'agentPlan' && log && log.status === 'success' && planFailed) {
    add('Result', 'Failed')
    add('Reason', humanReason(ctx.reason) || 'Plan did not stay clean')
  }
  if (/PlanFailed/.test(nodeId)) {
    add('Result', 'Failed')
    add('Message', ctx.message || 'Stopped: plan did not stay clean')
    add('Reason', humanReason(ctx.reason) || 'Plan did not stay clean')
  }

  add('Ticket', ctx.issueKey || jira.key)
  add('Summary', jira.summary || ctx.summary)
  return facts
}

export function approvalSubject(run) {
  const context = run && run.context && typeof run.context === 'object' ? run.context : {}
  const mode = typeof context.agentMode === 'string' ? context.agentMode : ''
  if (context.rulesReviewWait) {
    return 'Cursor asked for a human decision on rules-review uncertainties. The run stays paused until you approve or reject.'
  }
  if (mode === 'implement' || mode === 'fix') {
    return 'This is the Cursor prompt that will make the code changes. The run stays paused until you approve or reject it.'
  }
  if (mode === 'plan' || asPlan(context.plan)) {
    return 'This is the plan Cursor wrote, plus the prompt used to produce it. The run stays paused until you approve. After you approve, implementation starts.'
  }
  if (promptFromContext(context)) {
    return 'This is the Cursor prompt for this step. The run stays paused until you approve or reject it.'
  }
  return 'The run is paused until you approve or reject this step.'
}
