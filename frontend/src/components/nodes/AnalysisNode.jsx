import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'

function AnalysisNode({ data, selected }) {
  const title = data?.config?.title || 'Analysis'
  return (
    <div className={`canvas-node${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable className="handle-in" />
      <div className="canvas-node-badge">ANALYSIS</div>
      <div className="canvas-node-title">{title}</div>
      <div className="canvas-node-url">Summarize the ticket</div>
      <Handle type="source" position={Position.Bottom} id="out" isConnectable className="handle-out" />
    </div>
  )
}

export default memo(AnalysisNode)
