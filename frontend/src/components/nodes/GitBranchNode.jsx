import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'

function GitBranchNode({ data, selected }) {
  const title = data?.config?.title || 'Git branch'
  return (
    <div className={`canvas-node${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable className="handle-in" />
      <div className="canvas-node-badge">GIT</div>
      <div className="canvas-node-title">{title}</div>
      <div className="canvas-node-url">Worktree for this run</div>
      <Handle type="source" position={Position.Bottom} id="out" isConnectable className="handle-out" />
    </div>
  )
}

export default memo(GitBranchNode)
