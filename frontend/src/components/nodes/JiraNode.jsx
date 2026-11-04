import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'

function JiraNode({ data, selected }) {
  const title = data?.config?.title || 'Jira'
  return (
    <div className={`canvas-node${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable className="handle-in" />
      <div className="canvas-node-badge">JIRA</div>
      <div className="canvas-node-title">{title}</div>
      <div className="canvas-node-url">Load the issue</div>
      <Handle type="source" position={Position.Bottom} id="out" isConnectable className="handle-out" />
    </div>
  )
}

export default memo(JiraNode)
