import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  Panel,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import HttpNode from '../components/nodes/HttpNode'
import ConditionNode from '../components/nodes/ConditionNode'
import DelayNode from '../components/nodes/DelayNode'
import NotifyNode from '../components/nodes/NotifyNode'
import ApprovalNode from '../components/nodes/ApprovalNode'
import JiraNode from '../components/nodes/JiraNode'
import JiraUpdateNode from '../components/nodes/JiraUpdateNode'
import AnalysisNode from '../components/nodes/AnalysisNode'
import CursorPromptNode from '../components/nodes/CursorPromptNode'
import GitBranchNode from '../components/nodes/GitBranchNode'
import CursorAgentNode from '../components/nodes/CursorAgentNode'
import PlaywrightNode from '../components/nodes/PlaywrightNode'
import GithubPrNode from '../components/nodes/GithubPrNode'
import KeyValueRows from '../components/KeyValueRows'
import UxSection from '../components/UxSection'
import { jiraApi, webhookUrl, workflowApi } from '../lib/api'
import {
  bodyObjectToRows,
  headersObjectToRows,
  isSimpleFlatBody,
  rowsToBodyObject,
  rowsToHeadersObject,
} from '../lib/payloadForms'
import {
  buildCronFromPicker,
  defaultCronDatetimeLocal,
  parseCronForPicker,
  parsedCronToDatetimeLocal,
} from '../lib/cronPicker'
import {
  defaultConfigForType,
  edgeToBackend,
  newNodeId,
  nodeToBackend,
  workflowToFlow,
} from '../lib/workflowCanvas'

const nodeTypes = {
  http: HttpNode,
  condition: ConditionNode,
  delay: DelayNode,
  notify: NotifyNode,
  approval: ApprovalNode,
  jira: JiraNode,
  jiraUpdate: JiraUpdateNode,
  analysis: AnalysisNode,
  cursorPrompt: CursorPromptNode,
  gitBranch: GitBranchNode,
  cursorAgent: CursorAgentNode,
  playwright: PlaywrightNode,
  githubPr: GithubPrNode,
}

const branchNodeTypes = new Set(['approval', 'cursorAgent', 'playwright'])

function parseBodyJson(text) {
  const t = text.trim()
  if (!t) return {}
  const parsed = JSON.parse(t)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Body must be a JSON object')
  }
  return parsed
}

export default function WorkflowEditor() {
  const { id } = useParams()
  const [name, setName] = useState('Workflow')
  const [status, setStatus] = useState('draft')
  const [triggerType, setTriggerType] = useState('webhook')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [webhookSecretSet, setWebhookSecretSet] = useState(false)
  const [cronRepeat, setCronRepeat] = useState('daily')
  const [cronDateTime, setCronDateTime] = useState(() => defaultCronDatetimeLocal())
  const [cronAdvanced, setCronAdvanced] = useState(false)
  const [cronAdvancedExpr, setCronAdvancedExpr] = useState('')
  const [triggersEnabled, setTriggersEnabled] = useState(true)
  const [webhookProvider, setWebhookProvider] = useState('generic')
  const [repoLocation, setRepoLocation] = useState('')
  const [repoBranch, setRepoBranch] = useState('main')
  const [repoCredentialRef, setRepoCredentialRef] = useState('GITHUB_TOKEN')

  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [starting, setStarting] = useState(false)
  const [jiraIssue, setJiraIssue] = useState('')
  const [togglingPause, setTogglingPause] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [selectedEdgeId, setSelectedEdgeId] = useState(null)
  const [selectedNodeId, setSelectedNodeId] = useState(null)
  const [httpHeaderRows, setHttpHeaderRows] = useState([{ key: '', value: '' }])
  const [httpBodyRows, setHttpBodyRows] = useState([{ key: '', value: '' }])
  const [httpBodyMode, setHttpBodyMode] = useState('fields')
  const [httpBodyRaw, setHttpBodyRaw] = useState('{}')
  const [loadError, setLoadError] = useState('')

  const canEditGraph = status !== 'published'
  const isPublished = status === 'published'

  const reloadWorkflow = useCallback(async () => {
    const { data } = await workflowApi.get(id)
    setName(data.name || 'Workflow')
    setStatus(data.status || 'draft')
    const tt = data.trigger?.type
    if (tt === 'cron') {
      setTriggerType('cron')
      const raw = typeof data.trigger?.config?.cron === 'string' ? data.trigger.config.cron : ''
      const parsed = parseCronForPicker(raw)
      if (parsed) {
        setCronAdvanced(false)
        setCronRepeat(parsed.repeat)
        setCronDateTime(parsedCronToDatetimeLocal(parsed))
        setCronAdvancedExpr('')
      } else if (raw.trim()) {
        setCronAdvanced(true)
        setCronAdvancedExpr(raw.trim())
        setCronRepeat('daily')
        setCronDateTime(defaultCronDatetimeLocal())
      } else {
        setCronAdvanced(false)
        setCronRepeat('daily')
        setCronDateTime(defaultCronDatetimeLocal())
        setCronAdvancedExpr('')
      }
      setTriggersEnabled(data.trigger?.enabled !== false)
      setWebhookSecret('')
      setWebhookSecretSet(false)
    } else if (tt === 'webhook') {
      setTriggerType('webhook')
      setWebhookSecret(
        typeof data.trigger?.config?.secret === 'string' ? data.trigger.config.secret : ''
      )
      setWebhookSecretSet(data.trigger?.config?.secretSet === true)
      setWebhookProvider(data.trigger?.config?.provider === 'jira' ? 'jira' : 'generic')
      setCronAdvanced(false)
      setCronRepeat('daily')
      setCronDateTime(defaultCronDatetimeLocal())
      setCronAdvancedExpr('')
      setTriggersEnabled(data.trigger?.enabled !== false)
    } else {
      setTriggerType('webhook')
      setWebhookSecret('')
      setWebhookSecretSet(false)
      setCronAdvanced(false)
      setCronRepeat('daily')
      setCronDateTime(defaultCronDatetimeLocal())
      setCronAdvancedExpr('')
      setTriggersEnabled(true)
    }
    const repo = data.repository || {}
    setRepoLocation(typeof repo.location === 'string' ? repo.location : '')
    setRepoBranch(typeof repo.defaultBranch === 'string' && repo.defaultBranch ? repo.defaultBranch : 'main')
    setRepoCredentialRef(
      typeof repo.credentialRef === 'string' && repo.credentialRef ? repo.credentialRef : 'GITHUB_TOKEN'
    )
    const { nodes: n, edges: e } = workflowToFlow(data)
    setNodes(n)
    setEdges(e)
  }, [id, setNodes, setEdges])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setLoadError('')
      setError('')
      setMessage('')
      try {
        await reloadWorkflow()
      } catch (err) {
        if (!cancelled) {
          setLoadError(err.response?.data?.error || err.message || 'Failed to load workflow')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id, reloadWorkflow])

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) || null,
    [nodes, selectedNodeId]
  )

  useEffect(() => {
    if (!selectedNode || selectedNode.type !== 'http') return
    const h = selectedNode.data?.config?.headers
    setHttpHeaderRows(headersObjectToRows(h))
    const b = selectedNode.data?.config?.body
    if (isSimpleFlatBody(b)) {
      setHttpBodyMode('fields')
      setHttpBodyRows(bodyObjectToRows(b))
      setHttpBodyRaw('{}')
    } else {
      setHttpBodyMode('raw')
      try {
        setHttpBodyRaw(b != null ? JSON.stringify(b, null, 2) : '{}')
      } catch {
        setHttpBodyRaw('{}')
      }
      setHttpBodyRows([{ key: '', value: '' }])
    }
  }, [selectedNodeId, selectedNode])

  const onConnect = useCallback(
    (params) => {
      if (!canEditGraph) return
      const condition =
        params.sourceHandle === 'true' || params.sourceHandle === 'false' ? params.sourceHandle : ''
      setEdges((eds) =>
        addEdge(
          {
            ...params,
            type: 'smoothstep',
            data: { condition },
            label: condition,
          },
          eds
        )
      )
    },
    [setEdges, canEditGraph]
  )

  const addNode = useCallback(
    (nodeType) => {
      if (!canEditGraph) return
      const nid = newNodeId()
      const cfg = defaultConfigForType(nodeType)
      const labels = {
        http: 'HTTP request',
        condition: 'Condition',
        delay: 'Delay',
        notify: 'Notify',
        approval: 'Approval',
        jira: 'Jira',
        jiraUpdate: 'Jira update',
        analysis: 'Analysis',
        cursorPrompt: 'Cursor prompt',
        gitBranch: 'Git branch',
        cursorAgent: 'Cursor agent',
        playwright: 'Playwright',
        githubPr: 'Pull request',
      }
      setNodes((nds) => [
        ...nds,
        {
          id: nid,
          type: nodeType,
          position: { x: 120 + nds.length * 24, y: 80 + nds.length * 24 },
          data: { label: labels[nodeType] || nodeType, config: cfg },
        },
      ])
      setSelectedNodeId(nid)
      setSelectedEdgeId(null)
    },
    [setNodes, canEditGraph]
  )

  const deleteSelected = useCallback(() => {
    if (!canEditGraph) return
    if (selectedNodeId) {
      setNodes((nds) => nds.filter((n) => n.id !== selectedNodeId))
      setEdges((eds) => eds.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId))
      setSelectedNodeId(null)
      return
    }
    if (selectedEdgeId) {
      setEdges((eds) => eds.filter((e) => e.id !== selectedEdgeId))
      setSelectedEdgeId(null)
    }
  }, [selectedNodeId, selectedEdgeId, setNodes, setEdges, canEditGraph])

  const updateSelectedNodeConfig = useCallback(
    (patch) => {
      if (!selectedNodeId || !canEditGraph) return
      setNodes((nds) =>
        nds.map((n) =>
          n.id === selectedNodeId
            ? { ...n, data: { ...n.data, config: { ...n.data.config, ...patch } } }
            : n
        )
      )
    },
    [selectedNodeId, setNodes, canEditGraph]
  )

  const selectedEdge = useMemo(
    () => edges.find((e) => e.id === selectedEdgeId) || null,
    [edges, selectedEdgeId]
  )

  const setEdgeCondition = useCallback(
    (condition) => {
      if (!selectedEdgeId || !canEditGraph) return
      setEdges((eds) =>
        eds.map((e) => {
          if (e.id !== selectedEdgeId) return e
          const source = nodes.find((n) => n.id === e.source)
          const branched = condition === 'true' || condition === 'false'
          return {
            ...e,
            sourceHandle: branchNodeTypes.has(source?.type) && branched ? condition : undefined,
            data: { ...e.data, condition },
            label: branched ? condition : '',
          }
        })
      )
    },
    [selectedEdgeId, setEdges, canEditGraph, nodes]
  )

  function buildRepositoryPayload() {
    return {
      location: repoLocation.trim(),
      defaultBranch: repoBranch.trim(),
      credentialRef: repoCredentialRef.trim(),
    }
  }

  function buildTriggerPayload() {
    if (triggerType === 'webhook') {
      const config = {}
      if (webhookProvider === 'jira') config.provider = 'jira'
      if (webhookSecret.trim()) config.secret = webhookSecret.trim()
      else if (webhookSecretSet) config.secretSet = true
      return { type: 'webhook', enabled: triggersEnabled, config }
    }
    const cron = cronAdvanced
      ? cronAdvancedExpr.trim()
      : buildCronFromPicker(cronDateTime, cronRepeat)
    return {
      type: 'cron',
      enabled: triggersEnabled,
      config: { cron },
    }
  }

  async function handlePauseResume(nextEnabled) {
    setTogglingPause(true)
    setError('')
    setMessage('')
    try {
      const { data } = await workflowApi.patchTriggerEnabled(id, nextEnabled)
      setTriggersEnabled(data.trigger?.enabled !== false)
      setMessage(nextEnabled ? 'Workflow resumed' : 'Workflow paused')
      setTimeout(() => setMessage(''), 2500)
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Could not update pause state')
    } finally {
      setTogglingPause(false)
    }
  }

  async function handlePublish() {
    setPublishing(true)
    setError('')
    setMessage('')
    try {
      const savePayload = {
        name: name.trim() || 'Untitled',
        status: 'draft',
        trigger: buildTriggerPayload(),
        repository: buildRepositoryPayload(),
        nodes: nodes.map(nodeToBackend),
        edges: edges.map(edgeToBackend),
      }
      await workflowApi.patch(id, savePayload)
      await workflowApi.publish(id)
      await reloadWorkflow()
      setMessage('Published — graph is now frozen. You can still rename or pause.')
      setTimeout(() => setMessage(''), 4000)
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Publish failed')
    } finally {
      setPublishing(false)
    }
  }

  async function handleRunNow() {
    setStarting(true)
    setError('')
    setMessage('')
    try {
      const issue = jiraIssue.trim()
      if (issue) {
        const { data } = await jiraApi.run(issue)
        setMessage(`Queued — ${data.jiraKey} run ${data.runId}`)
      } else {
        const { data } = await workflowApi.start(id, {})
        setMessage(`Queued — jobId: ${data.jobId}`)
      }
      setTimeout(() => setMessage(''), 4000)
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Start failed')
    } finally {
      setStarting(false)
    }
  }

  async function handleSave() {
    setSaving(true)
    setMessage('')
    setError('')
    try {
      if (isPublished) {
        await workflowApi.patch(id, { name: name.trim() || 'Untitled' })
      } else {
        const payload = {
          name: name.trim() || 'Untitled',
          status: 'draft',
          trigger: buildTriggerPayload(),
          repository: buildRepositoryPayload(),
          nodes: nodes.map(nodeToBackend),
          edges: edges.map(edgeToBackend),
        }
        await workflowApi.patch(id, payload)
      }
      setMessage('Saved')
      setTimeout(() => setMessage(''), 2500)
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  function applyHttpPayloadFromInspector() {
    if (!selectedNodeId || !canEditGraph) return
    setError('')
    try {
      const headers = rowsToHeadersObject(httpHeaderRows)
      let body
      if (httpBodyMode === 'fields') {
        body = rowsToBodyObject(httpBodyRows)
      } else {
        body = parseBodyJson(httpBodyRaw)
      }
      updateSelectedNodeConfig({ headers, body })
      setMessage('Request headers & body updated')
      setTimeout(() => setMessage(''), 2000)
    } catch (e) {
      setError(e?.message || 'Check body JSON (advanced mode) or field values')
    }
  }

  const onSelectionChange = useCallback(({ nodes: ns, edges: es }) => {
    if (ns.length === 1) {
      setSelectedNodeId(ns[0].id)
      setSelectedEdgeId(null)
    } else if (es.length === 1) {
      setSelectedEdgeId(es[0].id)
      setSelectedNodeId(null)
    } else {
      setSelectedNodeId(null)
      setSelectedEdgeId(null)
    }
  }, [])

  const branchHints = useMemo(() => {
    const labelFor = (nodeId) => {
      const n = nodes.find((x) => x.id === nodeId)
      const t = n?.data?.label
      if (typeof t === 'string' && t.trim()) return `“${t.trim()}”`
      return `Step (${nodeId.slice(0, 6)}…)`
    }
    const bySource = new Map()
    for (const e of edges) {
      const k = e.source
      bySource.set(k, (bySource.get(k) || 0) + 1)
    }
    const warnings = []
    for (const [src, count] of bySource) {
      if (count > 1) {
        const outs = edges.filter((e) => e.source === src)
        const labeled = outs.filter(
          (e) => e.data?.condition === 'true' || e.data?.condition === 'false'
        )
        if (labeled.length !== outs.length) {
          warnings.push(
            `${labelFor(src)} splits into ${count} paths. Click each connecting line on the board, then choose True or False in the panel below.`
          )
        }
        const ts = outs.filter((e) => e.data?.condition === 'true').length
        const fs = outs.filter((e) => e.data?.condition === 'false').length
        if (count === 2 && (ts !== 1 || fs !== 1)) {
          warnings.push(
            `${labelFor(src)} should have exactly one True line and one False line.`
          )
        }
      }
    }
    return warnings
  }, [edges, nodes])

  const canvasNodeLabel = useCallback((nodeId) => {
    const n = nodes.find((x) => x.id === nodeId)
    const t = n?.data?.label
    if (typeof t === 'string' && t.trim()) return t.trim()
    return `Step ${nodeId.slice(0, 6)}…`
  }, [nodes])

  if (loading) {
    return (
      <div className="page-center">
        <div className="spinner" />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="narrow">
        <div className="alert alert-error">{loadError}</div>
        <Link to="/">Back to workflows</Link>
      </div>
    )
  }

  const hookUrl = webhookUrl(id)
  const nodeKind = selectedNode?.type

  return (
    <div className="editor-layout editor-future">
      <aside className="editor-sidebar">
        <div className="sidebar-header">
          <Link to="/" className="back-link">
            ← All workflows
          </Link>
          <h1>Workflow builder</h1>
          <p className="sidebar-subtitle muted small">
            Connect steps on the board. Use this panel top-to-bottom — each block matches what most people do
            first.
          </p>
        </div>

        {error ? <div className="alert alert-error">{error}</div> : null}
        {message ? <div className="alert alert-success">{message}</div> : null}

        <UxSection
          step={1}
          title="Name and status"
          hint="Rename anytime. While published, only the name can change — the diagram stays fixed."
        >
          <div className="field">
            <span>Status</span>
            <div className="state-row">
              {isPublished ? (
                <span className="badge badge-ok">Published — diagram locked</span>
              ) : (
                <span className="badge badge-muted">Draft</span>
              )}
              <Link to={`/workflows/${id}/runs`} className="btn btn-ghost small-link">
                View run history
              </Link>
            </div>
          </div>
          <label className="field">
            <span>Workflow name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. New user onboarding"
              aria-label="Workflow name"
            />
          </label>
        </UxSection>

        <UxSection
          step={2}
          title="When should it run?"
          hint="Pick how a run starts. If the diagram is still editable, use Save draft after changing this."
        >
          <fieldset className="fieldset" disabled={!canEditGraph}>
            <legend>Start method</legend>
            <label className="field-inline">
              <input
                type="radio"
                name="trig"
                checked={triggerType === 'webhook'}
                onChange={() => setTriggerType('webhook')}
              />
              Incoming HTTP (webhook)
            </label>
            <p className="muted small field-hang">
              Another service calls your URL with <strong>POST</strong> and a <strong>JSON object</strong> body to
              start a run.
            </p>
            <label className="field-inline">
              <input
                type="radio"
                name="trig"
                checked={triggerType === 'cron'}
                onChange={() => {
                  setTriggerType('cron')
                  setCronDateTime((prev) => prev || defaultCronDatetimeLocal())
                }}
              />
              On a schedule (cron)
            </label>
            <p className="muted small field-hang">
              Pick a date and time below. The app turns it into the schedule format the server expects — no manual
              cron text unless you use advanced mode.
            </p>
          </fieldset>

          {triggerType === 'webhook' ? (
            <>
              <label className="field">
                <span>Webhook source</span>
                <select
                  value={webhookProvider}
                  onChange={(e) => setWebhookProvider(e.target.value)}
                  disabled={!canEditGraph}
                >
                  <option value="generic">Generic JSON webhook</option>
                  <option value="jira">Jira Automation</option>
                </select>
              </label>
              {webhookProvider === 'jira' ? (
                <p className="muted small">
                  Jira sends <code className="inline-code">issueKey</code> and <code className="inline-code">eventId</code>.
                  The API compares <code className="inline-code">X-Webhook-Secret</code> with{' '}
                  <code className="inline-code">JIRA_WEBHOOK_SECRET</code>. The token stays on the server.
                </p>
              ) : null}
              <label className="field">
                <span>Shared secret (optional)</span>
                <input
                  value={webhookSecret}
                  onChange={(e) => setWebhookSecret(e.target.value)}
                  placeholder={
                    webhookSecretSet
                      ? 'A secret is saved. Type a new one to replace it.'
                      : 'If set, callers must send header X-Webhook-Secret'
                  }
                  disabled={!canEditGraph}
                />
              </label>
            </>
          ) : null}

          {triggerType === 'cron' ? (
            <>
              {!cronAdvanced ? (
                <>
                  <label className="field">
                    <span>How often</span>
                    <select
                      value={cronRepeat}
                      onChange={(e) => setCronRepeat(e.target.value)}
                      disabled={!canEditGraph}
                    >
                      <option value="daily">Every day at this time</option>
                      <option value="yearly">Every year on this date and time</option>
                    </select>
                  </label>
                  <p className="muted small">
                    {cronRepeat === 'daily'
                      ? 'Only the clock time matters — the workflow runs every day at that time. The date you pick is just for choosing the time.'
                      : 'Runs on this month and day each year at the time you pick.'}{' '}
                    The saved value is a standard cron string; the worker evaluates it in the{' '}
                    <strong>server&apos;s</strong> time zone.
                  </p>
                  <label className="field">
                    <span>Date and time</span>
                    <input
                      type="datetime-local"
                      value={cronDateTime}
                      onChange={(e) => setCronDateTime(e.target.value)}
                      disabled={!canEditGraph}
                    />
                  </label>
                  <p className="muted small mono-pill cron-preview" aria-live="polite">
                    Stored schedule:{' '}
                    <code className="inline-code">{buildCronFromPicker(cronDateTime, cronRepeat)}</code>
                  </p>
                </>
              ) : (
                <label className="field">
                  <span>Custom cron (5 fields: minute hour day month weekday)</span>
                  <input
                    value={cronAdvancedExpr}
                    onChange={(e) => setCronAdvancedExpr(e.target.value)}
                    placeholder="e.g. */15 * * * *"
                    disabled={!canEditGraph}
                    spellCheck={false}
                  />
                </label>
              )}
              <label className="field-inline field cron-advanced-toggle">
                <input
                  type="checkbox"
                  checked={cronAdvanced}
                  onChange={(e) => {
                    const on = e.target.checked
                    if (on) {
                      if (!cronAdvancedExpr.trim()) {
                        setCronAdvancedExpr(buildCronFromPicker(cronDateTime, cronRepeat))
                      }
                      setCronAdvanced(true)
                      return
                    }
                    const parsed = parseCronForPicker(cronAdvancedExpr.trim())
                    if (parsed) {
                      setCronRepeat(parsed.repeat)
                      setCronDateTime(parsedCronToDatetimeLocal(parsed))
                    }
                    setCronAdvanced(false)
                  }}
                  disabled={!canEditGraph}
                />
                <span>Custom cron expression (advanced)</span>
              </label>
              <label className="field-inline field">
                <input
                  type="checkbox"
                  checked={triggersEnabled}
                  onChange={(e) => setTriggersEnabled(e.target.checked)}
                  disabled={!canEditGraph}
                />
                <span>Enable this schedule</span>
              </label>
              <p className="muted small">
                Turn off to pause cron without deleting your settings. When published, you can also use Pause in
                step 4.
              </p>
              {isPublished && !triggersEnabled ? (
                <p className="muted small">Cron is off — enable the checkbox after Save, or use Resume in step 4.</p>
              ) : null}
            </>
          ) : null}
        </UxSection>

        <UxSection
          step={3}
          title="Application repository"
          hint="Set this once for the workflow. The credential reference is the name of an environment variable on the workflow worker, not the token."
        >
          <label className="field">
            <span>Repository location</span>
            <input
              value={repoLocation}
              onChange={(e) => setRepoLocation(e.target.value)}
              placeholder="Path the worker can read, or the repository URL"
              disabled={!canEditGraph}
            />
          </label>
          <label className="field">
            <span>Default branch</span>
            <input
              value={repoBranch}
              onChange={(e) => setRepoBranch(e.target.value)}
              placeholder="main"
              disabled={!canEditGraph}
            />
          </label>
          <label className="field">
            <span>Credential reference</span>
            <input
              value={repoCredentialRef}
              onChange={(e) => setRepoCredentialRef(e.target.value)}
              placeholder="GITHUB_TOKEN"
              disabled={!canEditGraph}
            />
          </label>
        </UxSection>

        <UxSection
          step={4}
          title="Build your steps"
          hint={
            canEditGraph
              ? 'Exactly one step must be the start (nothing connects into it). Drag from the bottom dot of one step to the top dot of the next.'
              : 'Published workflows cannot move or rewire steps. Open a draft copy from the dashboard if you need big changes.'
          }
        >
          {canEditGraph ? (
            <ul className="ux-tip-list">
              <li>Add steps with the tiles below.</li>
              <li>Click a step on the board to edit URL, headers, timing, or messages here.</li>
              <li>
                After a <strong>Condition</strong>, <strong>Approval</strong>, <strong>Cursor agent</strong>, or{' '}
                <strong>Playwright</strong> step, draw two lines and mark each as True or False. Approval uses the
                Approve and Reject dots.
              </li>
            </ul>
          ) : null}

          <div className="ux-node-grid">
            <button
              type="button"
              className="ux-node-card"
              onClick={() => addNode('http')}
              disabled={!canEditGraph}
            >
              <span className="ux-node-card-title">HTTP request</span>
              <span className="ux-node-card-desc">Call an API and pass the response to the next step</span>
            </button>
            <button
              type="button"
              className="ux-node-card"
              onClick={() => addNode('condition')}
              disabled={!canEditGraph}
            >
              <span className="ux-node-card-title">Condition</span>
              <span className="ux-node-card-desc">Split into yes / no paths using data from the previous step</span>
            </button>
            <button
              type="button"
              className="ux-node-card"
              onClick={() => addNode('delay')}
              disabled={!canEditGraph}
            >
              <span className="ux-node-card-title">Wait</span>
              <span className="ux-node-card-desc">Pause up to 60 seconds before continuing</span>
            </button>
            <button
              type="button"
              className="ux-node-card"
              onClick={() => addNode('notify')}
              disabled={!canEditGraph}
            >
              <span className="ux-node-card-title">Notify</span>
              <span className="ux-node-card-desc">Send a Slack message (if the server is configured)</span>
            </button>
            <button
              type="button"
              className="ux-node-card"
              onClick={() => addNode('approval')}
              disabled={!canEditGraph}
            >
              <span className="ux-node-card-title">Approval</span>
              <span className="ux-node-card-desc">Pause until you approve or reject this run</span>
            </button>
            <button type="button" className="ux-node-card" onClick={() => addNode('jira')} disabled={!canEditGraph}>
              <span className="ux-node-card-title">Jira issue</span>
              <span className="ux-node-card-desc">Load the ticket summary and description</span>
            </button>
            <button type="button" className="ux-node-card" onClick={() => addNode('jiraUpdate')} disabled={!canEditGraph}>
              <span className="ux-node-card-title">Jira update</span>
              <span className="ux-node-card-desc">Transition the ticket or post a comment once per run</span>
            </button>
            <button type="button" className="ux-node-card" onClick={() => addNode('analysis')} disabled={!canEditGraph}>
              <span className="ux-node-card-title">Analysis</span>
              <span className="ux-node-card-desc">Summarize the ticket before anyone edits the repo</span>
            </button>
            <button type="button" className="ux-node-card" onClick={() => addNode('cursorPrompt')} disabled={!canEditGraph}>
              <span className="ux-node-card-title">Cursor prompt</span>
              <span className="ux-node-card-desc">Build the prompt the approval step will show</span>
            </button>
            <button type="button" className="ux-node-card" onClick={() => addNode('gitBranch')} disabled={!canEditGraph}>
              <span className="ux-node-card-title">Git branch</span>
              <span className="ux-node-card-desc">Create this run’s worktree after approval</span>
            </button>
            <button type="button" className="ux-node-card" onClick={() => addNode('cursorAgent')} disabled={!canEditGraph}>
              <span className="ux-node-card-title">Cursor agent</span>
              <span className="ux-node-card-desc">Edit the worktree. Done follows true, failure follows false</span>
            </button>
            <button type="button" className="ux-node-card" onClick={() => addNode('playwright')} disabled={!canEditGraph}>
              <span className="ux-node-card-title">Playwright</span>
              <span className="ux-node-card-desc">Run the suite against the tested revision</span>
            </button>
            <button type="button" className="ux-node-card" onClick={() => addNode('githubPr')} disabled={!canEditGraph}>
              <span className="ux-node-card-title">Pull request</span>
              <span className="ux-node-card-desc">Open a request after Playwright passes. Nothing here merges it</span>
            </button>
          </div>

          <div className="sidebar-actions-footer">
            <button type="button" className="btn btn-ghost" onClick={deleteSelected} disabled={!canEditGraph}>
              Remove selected
            </button>
            <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save draft'}
            </button>
          </div>
        </UxSection>

        {branchHints.length ? (
          <div className="hint-box hint-box-warn" role="status">
            <strong>Fix the diagram</strong>
            <ul>
              {branchHints.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <UxSection
          step={5}
          title="Go live"
          hint={
            isPublished
              ? 'Pause stops webhooks and cron. Run now runs once with empty input; use the webhook to send your own fields.'
              : 'Publish saves your latest diagram and trigger, checks that it is valid, then locks the board. You can still rename or pause later.'
          }
        >
          {!isPublished ? (
            <div className="field">
              <button
                type="button"
                className="btn btn-primary"
                onClick={handlePublish}
                disabled={publishing}
              >
                {publishing ? 'Publishing…' : 'Publish workflow'}
              </button>
              <p className="muted small">
                After publishing you get <strong>Run now</strong>, optional <strong>webhook URL</strong>, and{' '}
                <strong>pause</strong>. Fix any yellow warnings in the steps section first if they appear.
              </p>
            </div>
          ) : null}

          {isPublished ? (
            <>
              <div className="field">
                <span>Controls</span>
                <div className="pause-resume-row">
                  {triggersEnabled ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => handlePauseResume(false)}
                      disabled={togglingPause}
                    >
                      {togglingPause ? 'Updating…' : 'Pause'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => handlePauseResume(true)}
                      disabled={togglingPause}
                    >
                      {togglingPause ? 'Updating…' : 'Resume'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleRunNow}
                    disabled={starting || !triggersEnabled}
                    title={!triggersEnabled ? 'Resume the workflow first' : ''}
                  >
                    {starting ? 'Starting…' : 'Run now'}
                  </button>
                </div>
                <label className="field jira-issue-field">
                  <span>Jira ticket</span>
                  <input
                    value={jiraIssue}
                    onChange={(e) => setJiraIssue(e.target.value)}
                    placeholder="MF-123 or https://…/browse/MF-123"
                    disabled={starting}
                  />
                </label>
                <p className="muted small">
                  While paused, incoming webhooks and cron are rejected. Run now needs an active (non-paused)
                  workflow. Paste a Jira link or key to run that ticket; leave it empty to start this workflow
                  with no input.
                </p>
              </div>

              {triggerType === 'webhook' ? (
                <div className="field">
                  <span>Your webhook address</span>
                  <div className="copy-row">
                    <code className="code-block">{hookUrl}</code>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        navigator.clipboard.writeText(hookUrl)
                        setMessage('Webhook URL copied')
                        setTimeout(() => setMessage(''), 2000)
                      }}
                    >
                      Copy
                    </button>
                  </div>
                  <p className="muted small">
                    Send <strong>POST</strong> with <code className="inline-code">Content-Type: application/json</code>{' '}
                    and a flat JSON object (for example <code className="inline-code">orderId</code>,{' '}
                    <code className="inline-code">status</code>). That object becomes the starting data for the first
                    step.
                  </p>
                  {!triggersEnabled ? (
                    <p className="muted small">Webhook is paused — resume to accept traffic again.</p>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </UxSection>

        <div className="inspector inspector-glass">
          <h2 className="inspector-title">Step details</h2>
          {selectedNode && nodeKind === 'http' ? (
            <div className="form-stack tight">
              <p className="muted small mono-pill">ID · {selectedNode.id.slice(0, 8)}…</p>
              <label className="field">
                <span>Method</span>
                <select
                  value={selectedNode.data?.config?.method || 'GET'}
                  onChange={(e) => updateSelectedNodeConfig({ method: e.target.value })}
                  disabled={!canEditGraph}
                >
                  {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>URL</span>
                <input
                  value={selectedNode.data?.config?.url || ''}
                  onChange={(e) => updateSelectedNodeConfig({ url: e.target.value })}
                  disabled={!canEditGraph}
                  placeholder="https://httpbin.org/get"
                />
              </label>
              <div className="field">
                <span>Headers</span>
                <p className="muted small">Name / value pairs (e.g. Authorization, Content-Type).</p>
                <KeyValueRows
                  rows={httpHeaderRows}
                  onChange={setHttpHeaderRows}
                  disabled={!canEditGraph}
                  keyLabel="Header"
                  valueLabel="Value"
                />
              </div>
              <div className="field">
                <span>Request body</span>
                <div className="segmented">
                  <button
                    type="button"
                    className={httpBodyMode === 'fields' ? 'seg active' : 'seg'}
                    onClick={() => setHttpBodyMode('fields')}
                    disabled={!canEditGraph}
                  >
                    Fields
                  </button>
                  <button
                    type="button"
                    className={httpBodyMode === 'raw' ? 'seg active' : 'seg'}
                    onClick={() => setHttpBodyMode('raw')}
                    disabled={!canEditGraph}
                  >
                    Advanced JSON
                  </button>
                </div>
                {httpBodyMode === 'fields' ? (
                  <>
                    <p className="muted small">
                      Build a JSON object without typing braces: numbers and true/false are detected
                      automatically.
                    </p>
                    <KeyValueRows
                      rows={httpBodyRows}
                      onChange={setHttpBodyRows}
                      disabled={!canEditGraph}
                      keyLabel="Field"
                      valueLabel="Value"
                    />
                  </>
                ) : (
                  <>
                    <p className="muted small">For nested structures or arrays.</p>
                    <textarea
                      className="field-textarea-mono"
                      rows={8}
                      value={httpBodyRaw}
                      onChange={(e) => setHttpBodyRaw(e.target.value)}
                      spellCheck={false}
                      disabled={!canEditGraph}
                    />
                  </>
                )}
              </div>
              <button
                type="button"
                className="btn btn-primary btn-glow"
                onClick={applyHttpPayloadFromInspector}
                disabled={!canEditGraph}
              >
                Apply headers & body
              </button>
            </div>
          ) : selectedNode && nodeKind === 'condition' ? (
            <div className="form-stack tight">
              <p className="muted small">
                Looks at the <strong>output of the previous step</strong> (usually JSON from an HTTP request). Use
                dot paths for nested keys, e.g. <code className="inline-code">user.id</code>.
              </p>
              <label className="field">
                <span>Field path (dot notation)</span>
                <input
                  value={selectedNode.data?.config?.field || ''}
                  onChange={(e) => updateSelectedNodeConfig({ field: e.target.value })}
                  placeholder="e.g. completed or user.id"
                  disabled={!canEditGraph}
                />
              </label>
              <label className="field">
                <span>Operator</span>
                <select
                  value={selectedNode.data?.config?.operator || 'truthy'}
                  onChange={(e) => {
                    const operator = e.target.value
                    if (operator === 'equals') {
                      updateSelectedNodeConfig({
                        operator,
                        compareAs: 'string',
                        value: '',
                      })
                    } else {
                      updateSelectedNodeConfig({ operator })
                    }
                  }}
                  disabled={!canEditGraph}
                >
                  <option value="truthy">Has a true value</option>
                  <option value="exists">Field exists</option>
                  <option value="equals">Equals a value</option>
                </select>
              </label>
              {selectedNode.data?.config?.operator === 'equals' ? (
                <>
                  <label className="field">
                    <span>Compare as</span>
                    <select
                      value={selectedNode.data?.config?.compareAs || 'string'}
                      onChange={(e) => {
                        const compareAs = e.target.value
                        let value = selectedNode.data?.config?.value
                        if (compareAs === 'boolean') {
                          value = Boolean(value)
                        } else if (compareAs === 'number') {
                          value = Number(value)
                          if (Number.isNaN(value)) value = 0
                        } else {
                          value = value == null ? '' : String(value)
                        }
                        updateSelectedNodeConfig({ compareAs, value })
                      }}
                      disabled={!canEditGraph}
                    >
                      <option value="string">Text</option>
                      <option value="number">Number</option>
                      <option value="boolean">Yes / No</option>
                    </select>
                  </label>
                  {(selectedNode.data?.config?.compareAs || 'string') === 'boolean' ? (
                    <label className="field">
                      <span>Expected</span>
                      <select
                        value={selectedNode.data?.config?.value === false ? 'false' : 'true'}
                        onChange={(e) =>
                          updateSelectedNodeConfig({ value: e.target.value === 'true' })
                        }
                        disabled={!canEditGraph}
                      >
                        <option value="true">True</option>
                        <option value="false">False</option>
                      </select>
                    </label>
                  ) : (
                    <label className="field">
                      <span>Expected value</span>
                      <input
                        type={(selectedNode.data?.config?.compareAs || 'string') === 'number' ? 'number' : 'text'}
                        value={
                          (selectedNode.data?.config?.compareAs || 'string') === 'number'
                            ? String(
                                selectedNode.data?.config?.value !== undefined &&
                                  selectedNode.data?.config?.value !== null
                                  ? selectedNode.data.config.value
                                  : ''
                              )
                            : selectedNode.data?.config?.value !== undefined &&
                                selectedNode.data?.config?.value !== null
                              ? String(selectedNode.data.config.value)
                              : ''
                        }
                        onChange={(e) => {
                          const kind = selectedNode.data?.config?.compareAs || 'string'
                          if (kind === 'number') {
                            const n = Number(e.target.value)
                            updateSelectedNodeConfig({ value: Number.isNaN(n) ? 0 : n })
                          } else {
                            updateSelectedNodeConfig({ value: e.target.value })
                          }
                        }}
                        disabled={!canEditGraph}
                      />
                    </label>
                  )}
                </>
              ) : null}
            </div>
          ) : selectedNode && nodeKind === 'delay' ? (
            <div className="form-stack tight">
              <p className="muted small">
                Waits in the same run (demo cap: 60s). The next step runs after the wait finishes.
              </p>
              <label className="field">
                <span>Seconds (max 60)</span>
                <input
                  type="number"
                  min={0}
                  max={60}
                  value={selectedNode.data?.config?.seconds ?? 1}
                  onChange={(e) =>
                    updateSelectedNodeConfig({ seconds: Number(e.target.value) || 0 })
                  }
                  disabled={!canEditGraph}
                />
              </label>
            </div>
          ) : selectedNode && nodeKind === 'approval' ? (
            <div className="form-stack tight">
              <p className="muted small">
                The run pauses on this step until you approve or reject it. Connect Approve to the true path and Reject
                to the false path. The title is only a label.
              </p>
              <label className="field">
                <span>Title</span>
                <input
                  value={selectedNode.data?.config?.title || ''}
                  onChange={(e) => updateSelectedNodeConfig({ title: e.target.value })}
                  disabled={!canEditGraph}
                />
              </label>
            </div>
          ) : selectedNode && nodeKind === 'jiraUpdate' ? (
            <div className="form-stack tight">
              <p className="muted small">
                Transitions and comments run once per step. A run and stage marker is added so a retry does not
                post twice. Retries default to 1.
              </p>
              <label className="field">
                <span>Title</span>
                <input
                  value={selectedNode.data?.config?.title || ''}
                  onChange={(e) => updateSelectedNodeConfig({ title: e.target.value })}
                  disabled={!canEditGraph}
                />
              </label>
              <label className="field">
                <span>Transition</span>
                <input
                  value={selectedNode.data?.config?.transition || ''}
                  onChange={(e) => updateSelectedNodeConfig({ transition: e.target.value })}
                  placeholder="claim, review, blocked, or a status name"
                  disabled={!canEditGraph}
                />
              </label>
              <label className="field">
                <span>Comment</span>
                <textarea
                  rows={3}
                  value={selectedNode.data?.config?.comment || ''}
                  onChange={(e) => updateSelectedNodeConfig({ comment: e.target.value })}
                  disabled={!canEditGraph}
                />
              </label>
            </div>
          ) : selectedNode && ['jira', 'analysis', 'cursorPrompt', 'gitBranch', 'cursorAgent', 'githubPr'].includes(nodeKind) ? (
            <div className="form-stack tight">
              <p className="muted small">
                This title is a label. Repository paths, API tokens, and model keys stay in the worker environment.
              </p>
              <label className="field">
                <span>Title</span>
                <input
                  value={selectedNode.data?.config?.title || ''}
                  onChange={(e) => updateSelectedNodeConfig({ title: e.target.value })}
                  disabled={!canEditGraph}
                />
              </label>
              {nodeKind === 'cursorAgent' || nodeKind === 'cursorPrompt' ? (
                <label className="field">
                  <span>Mode</span>
                  <select
                    value={selectedNode.data?.config?.mode || ''}
                    onChange={(e) => updateSelectedNodeConfig({ mode: e.target.value })}
                    disabled={!canEditGraph}
                  >
                    <option value="">Default</option>
                    <option value="plan">Plan</option>
                    <option value="implement">Implement</option>
                    <option value="fix">Fix</option>
                    <option value="review">Review</option>
                  </select>
                </label>
              ) : null}
            </div>
          ) : selectedNode && nodeKind === 'playwright' ? (
            <div className="form-stack tight">
              <p className="muted small">
                Choose where the tests live and which application revision they boot. There is no default. Tokens stay
                in the environment.
              </p>
              <label className="field">
                <span>Title</span>
                <input
                  value={selectedNode.data?.config?.title || ''}
                  onChange={(e) => updateSelectedNodeConfig({ title: e.target.value })}
                  disabled={!canEditGraph}
                />
              </label>
              <label className="field">
                <span>Where the tests live</span>
                <select
                  value={selectedNode.data?.config?.strategy || ''}
                  onChange={(e) => updateSelectedNodeConfig({ strategy: e.target.value })}
                  disabled={!canEditGraph}
                >
                  <option value="">Choose one</option>
                  <option value="in-repo">Use the application repository for Playwright tests</option>
                  <option value="external-repo">Use a separate Playwright repository</option>
                </select>
              </label>
              <label className="field">
                <span>Application under test</span>
                <select
                  value={selectedNode.data?.config?.target || ''}
                  onChange={(e) => updateSelectedNodeConfig({ target: e.target.value })}
                  disabled={!canEditGraph}
                >
                  <option value="">Choose one</option>
                  <option value="local-worktree">Boot this run’s worktree</option>
                  <option value="deployed-preview">Deployed preview of the tested revision</option>
                </select>
              </label>
              {selectedNode.data?.config?.strategy === 'in-repo' ? (
                <label className="field">
                  <span>Test path</span>
                  <input
                    value={selectedNode.data?.config?.testPath || ''}
                    onChange={(e) => updateSelectedNodeConfig({ testPath: e.target.value })}
                    disabled={!canEditGraph}
                  />
                </label>
              ) : null}
              {selectedNode.data?.config?.strategy === 'external-repo' ? (
                <>
                  <label className="field">
                    <span>Playwright repository location</span>
                    <input
                      value={selectedNode.data?.config?.testRepository?.location || ''}
                      onChange={(e) =>
                        updateSelectedNodeConfig({
                          testRepository: {
                            ...(selectedNode.data?.config?.testRepository || {}),
                            location: e.target.value,
                          },
                        })
                      }
                      disabled={!canEditGraph}
                    />
                  </label>
                  <label className="field">
                    <span>Playwright default branch</span>
                    <input
                      value={selectedNode.data?.config?.testRepository?.defaultBranch || ''}
                      onChange={(e) =>
                        updateSelectedNodeConfig({
                          testRepository: {
                            ...(selectedNode.data?.config?.testRepository || {}),
                            defaultBranch: e.target.value,
                          },
                        })
                      }
                      disabled={!canEditGraph}
                    />
                  </label>
                  <label className="field">
                    <span>Test command, one argument per line</span>
                    <textarea
                      rows={3}
                      value={(selectedNode.data?.config?.testCommand || []).join('\n')}
                      onChange={(e) =>
                        updateSelectedNodeConfig({
                          testCommand: e.target.value.split('\n').map((line) => line.trim()).filter(Boolean),
                        })
                      }
                      disabled={!canEditGraph}
                    />
                  </label>
                </>
              ) : null}
              {selectedNode.data?.config?.target === 'local-worktree' ? (
                <>
                  <label className="field">
                    <span>App command, one argument per line</span>
                    <textarea
                      rows={3}
                      value={(selectedNode.data?.config?.appCommand || []).join('\n')}
                      onChange={(e) =>
                        updateSelectedNodeConfig({
                          appCommand: e.target.value.split('\n').map((line) => line.trim()).filter(Boolean),
                        })
                      }
                      disabled={!canEditGraph}
                    />
                  </label>
                  <label className="field">
                    <span>Readiness path</span>
                    <input
                      value={selectedNode.data?.config?.readiness || ''}
                      onChange={(e) => updateSelectedNodeConfig({ readiness: e.target.value })}
                      disabled={!canEditGraph}
                    />
                  </label>
                </>
              ) : null}
              {selectedNode.data?.config?.target === 'deployed-preview' ? (
                <p className="muted small">
                  A preview must prove the deployed revision. This workspace does not have a verified preview adapter,
                  so a run that selects this target fails closed.
                </p>
              ) : null}
            </div>
          ) : selectedNode && nodeKind === 'notify' ? (
            <div className="form-stack tight">
              <p className="muted small">
                Sends to Slack when the server has <code className="inline-code">SLACK_WEBHOOK_URL</code> set.
                Use <code className="inline-code">{'{{key}}'}</code> to insert values from the previous step’s data.
              </p>
              <label className="field">
                <span>Message</span>
                <textarea
                  rows={4}
                  value={selectedNode.data?.config?.message || ''}
                  onChange={(e) => updateSelectedNodeConfig({ message: e.target.value })}
                  disabled={!canEditGraph}
                />
              </label>
            </div>
          ) : selectedEdge ? (
            <div className="form-stack tight">
              <p className="muted small">
                Connection: <strong>{canvasNodeLabel(selectedEdge.source)}</strong> →{' '}
                <strong>{canvasNodeLabel(selectedEdge.target)}</strong>
              </p>
              <label className="field">
                <span>Meaning of this line</span>
                <select
                  value={
                    selectedEdge.data?.condition === 'true' || selectedEdge.data?.condition === 'false'
                      ? selectedEdge.data.condition
                      : ''
                  }
                  onChange={(e) => setEdgeCondition(e.target.value)}
                  disabled={!canEditGraph}
                >
                  <option value="">Single path (no split)</option>
                  <option value="true">When condition is true</option>
                  <option value="false">When condition is false</option>
                </select>
              </label>
              <p className="muted small">
                The two lines leaving a <strong>Condition</strong> or <strong>Approval</strong> should be True or False.
                Approve follows True. Reject follows False. Other steps keep “Single path”.
              </p>
            </div>
          ) : (
            <div className="inspector-empty">
              <p className="inspector-empty-lead">Select something on the board</p>
              <ul className="inspector-empty-list">
                <li>
                  <strong>Click a step</strong> to edit URL, headers, timing, or notifications.
                </li>
                <li>
                  <strong>Click a line</strong> after a Condition, Approval, Cursor agent, or Playwright step to mark the True or False path.
                </li>
              </ul>
            </div>
          )}
        </div>
      </aside>

      <div className="editor-canvas-wrap">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={canEditGraph ? onConnect : undefined}
          onSelectionChange={onSelectionChange}
          nodeTypes={nodeTypes}
          nodesDraggable={canEditGraph}
          nodesConnectable={canEditGraph}
          elementsSelectable
          fitView
          proOptions={{ hideAttribution: true }}
          deleteKeyCode={null}
        >
          <Background gap={22} color="var(--grid)" />
          <Controls />
          <MiniMap pannable zoomable />
          <Panel position="top-right" className="canvas-panel">
            <span className="muted small canvas-panel-text">
              {canEditGraph
                ? 'Drag steps to arrange. Connect: drag from the bottom dot to the top dot of the next step. Scroll to zoom.'
                : 'Published — view only. Pause or run from the left panel.'}
            </span>
          </Panel>
        </ReactFlow>
      </div>
    </div>
  )
}
