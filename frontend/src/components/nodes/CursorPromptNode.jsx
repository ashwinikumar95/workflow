import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'

function CursorPromptNode({ data, selected }) {
  const title = data?.config?.title || 'Cursor prompt'
  return (
    <div className={`canvas-node${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable className="handle-in" />
      <div className="canvas-node-badge">PROMPT</div>
      <div className="canvas-node-title">{title}</div>
      <div className="canvas-node-url">Build the agent prompt</div>
      <Handle type="source" position={Position.Bottom} id="out" isConnectable className="handle-out" />
    </div>
  )
}

export default memo(CursorPromptNode)
