import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'

function GithubPrNode({ data, selected }) {
  const title = data?.config?.title || 'Pull request'
  return (
    <div className={`canvas-node${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable className="handle-in" />
      <div className="canvas-node-badge">GITHUB</div>
      <div className="canvas-node-title">{title}</div>
      <div className="canvas-node-url">Open a pull request</div>
      <Handle type="source" position={Position.Bottom} id="out" isConnectable className="handle-out" />
    </div>
  )
}

export default memo(GithubPrNode)
