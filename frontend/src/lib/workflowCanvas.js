import { MarkerType } from '@xyflow/react'

const defaultHttpConfig = () => ({
  method: 'GET',
  url: 'https://httpbin.org/get',
  body: {},
  headers: {},
})

const defaultConditionConfig = () => ({
  field: '',
  operator: 'truthy',
  value: '',
})

const defaultDelayConfig = () => ({
  seconds: 1,
})

const defaultNotifyConfig = () => ({
  message: 'Workflow step: {{payload}}',
})

const defaultApprovalConfig = () => ({
  title: 'Approval',
})

const defaultJiraConfig = () => ({ title: 'Jira' })
const defaultJiraUpdateConfig = () => ({
  title: 'Jira update',
  transition: '',
  comment: '',
  retries: 1,
})
const defaultAnalysisConfig = () => ({ title: 'Analysis' })
const defaultCursorPromptConfig = () => ({ title: 'Cursor prompt' })
const defaultGitBranchConfig = () => ({ title: 'Git branch' })
const defaultCursorAgentConfig = () => ({ title: 'Cursor agent' })
const defaultPlaywrightConfig = () => ({
  title: 'Playwright',
  strategy: '',
  target: '',
  testPath: '',
  appCommand: [],
  readiness: '/health',
  testCommand: [],
  testRepository: { location: '', defaultBranch: '', credentialRef: '' },
})
const defaultGithubPrConfig = () => ({ title: 'Pull request' })

const branchTypes = new Set(['approval', 'cursorAgent', 'playwright'])

export function defaultConfigForType(type) {
  switch (type) {
    case 'condition':
      return defaultConditionConfig()
    case 'delay':
      return defaultDelayConfig()
    case 'notify':
      return defaultNotifyConfig()
    case 'approval':
      return defaultApprovalConfig()
    case 'jira':
      return defaultJiraConfig()
    case 'jiraUpdate':
      return defaultJiraUpdateConfig()
    case 'analysis':
      return defaultAnalysisConfig()
    case 'cursorPrompt':
      return defaultCursorPromptConfig()
    case 'gitBranch':
      return defaultGitBranchConfig()
    case 'cursorAgent':
      return defaultCursorAgentConfig()
    case 'playwright':
      return defaultPlaywrightConfig()
    case 'githubPr':
      return defaultGithubPrConfig()
    case 'http':
    default:
      return defaultHttpConfig()
  }
}

export function newNodeId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `n-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** @param {string} type @param {Record<string, unknown>|undefined} config */
export function executionConfigFromNodeConfig(type, config) {
  const base = defaultConfigForType(type)
  if (!config || typeof config !== 'object') return { ...base }
  const { __ui, ...rest } = config
  return { ...base, ...rest }
}

/** @param {import('@xyflow/react').Node} n */
export function nodeToBackend(n) {
  const exec = n.data?.config || {}
  const position = n.position || { x: 0, y: 0 }
  const nodeType = n.type || 'http'
  return {
    id: n.id,
    type: nodeType,
    config: {
      ...exec,
      __ui: { position },
    },
  }
}

/** @param {import('@xyflow/react').Edge} e */
export function edgeToBackend(e) {
  const cond = e.data?.condition
  const out = { from: e.source, to: e.target }
  if (cond === 'true' || cond === 'false') out.condition = cond
  return out
}

const labels = {
  http: 'HTTP',
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

/**
 * @param {Record<string, unknown>} workflow - API workflow doc
 * @returns {{ nodes: import('@xyflow/react').Node[], edges: import('@xyflow/react').Edge[] }}
 */
export function workflowToFlow(workflow) {
  const list = workflow.nodes || []
  const nodes = list.map((n, i) => {
    const rawType = typeof n.type === 'string' ? n.type : 'http'
    const cfg = n.config && typeof n.config === 'object' ? { ...n.config } : {}
    const pos = cfg.__ui?.position
    delete cfg.__ui
    const exec = executionConfigFromNodeConfig(rawType, cfg)
    const position =
      pos && typeof pos.x === 'number' && typeof pos.y === 'number'
        ? pos
        : { x: 80 + (i % 3) * 260, y: 60 + Math.floor(i / 3) * 160 }

    return {
      id: n.id,
      type: rawType,
      position,
      data: {
        label: labels[rawType] || rawType,
        config: exec,
      },
    }
  })

  const edges = (workflow.edges || []).map((e, idx) => {
    const sourceNode = list.find((n) => n.id === e.from)
    const branched = e.condition === 'true' || e.condition === 'false'
    return {
      id: `e-${e.from}-${e.to}-${idx}`,
      source: e.from,
      target: e.to,
      sourceHandle: branchTypes.has(sourceNode?.type) && branched ? e.condition : undefined,
      label: branched ? e.condition : '',
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--edge)' },
      data: { condition: branched ? e.condition : '' },
    }
  })

  return { nodes, edges }
}

export {
  defaultHttpConfig,
  defaultConditionConfig,
  defaultDelayConfig,
  defaultNotifyConfig,
  defaultApprovalConfig,
}
