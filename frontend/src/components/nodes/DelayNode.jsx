import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'

function DelayNode({ data, selected }) {
  const sec = data?.config?.seconds ?? 1

  return (
    <div className={`canvas-node delay-node${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable className="handle-in" />
      <div className="canvas-node-badge">WAIT</div>
      <div className="canvas-node-title">Delay</div>
      <div className="canvas-node-method">{sec}s</div>
      <div className="canvas-node-url muted">max 60s</div>
      <Handle type="source" position={Position.Bottom} id="out" isConnectable className="handle-out" />
    </div>
  )
}

export default memo(DelayNode)
