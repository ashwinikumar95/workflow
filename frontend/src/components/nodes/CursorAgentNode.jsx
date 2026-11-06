import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'

function CursorAgentNode({ data, selected }) {
  const title = data?.config?.title || 'Cursor agent'
  const mode = data?.config?.mode
  return (
    <div className={`canvas-node branch-node${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable className="handle-in" />
      <div className="canvas-node-badge">AGENT</div>
      <div className="canvas-node-title">{title}</div>
      <div className="canvas-node-url">{mode ? `Mode: ${mode}` : 'Edit the worktree'}</div>
      <div className="approval-handles">
        <span>Done</span>
        <span>Failed</span>
      </div>
      <Handle type="source" position={Position.Bottom} id="true" isConnectable className="handle-out handle-true" />
      <Handle type="source" position={Position.Bottom} id="false" isConnectable className="handle-out handle-false" />
    </div>
  )
}

export default memo(CursorAgentNode)
