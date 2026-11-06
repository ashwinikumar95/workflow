import { memo } from 'react'

import { Handle, Position } from '@xyflow/react'

function JiraUpdateNode({ data, selected }) {
  const title = data?.config?.title || 'Jira update'
  const transition = data?.config?.transition || ''
  const comment = data?.config?.comment || ''
  const summary = transition || (comment ? 'Comment' : 'Update Jira')
  return (
    <div className={`canvas-node${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable className="handle-in" />
      <div className="canvas-node-badge">JIRA</div>
      <div className="canvas-node-title">{title}</div>
      <div className="canvas-node-url">{summary}</div>
      <Handle type="source" position={Position.Bottom} id="out" isConnectable className="handle-out" />
    </div>
  )
}

export default memo(JiraUpdateNode)
