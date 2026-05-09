import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'

function HttpNode({ data, selected }) {
  const method = data?.config?.method || 'GET'
  const url = data?.config?.url || 'Set URL in inspector'
  const short = url.length > 40 ? `${url.slice(0, 38)}…` : url

  return (
    <div className={`canvas-node http-node${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable className="handle-in" />
      <div className="canvas-node-badge">HTTP</div>
      <div className="canvas-node-title">Request</div>
      <div className="canvas-node-method">{method}</div>
      <div className="canvas-node-url" title={url}>
        {short}
      </div>
      <Handle type="source" position={Position.Bottom} id="out" isConnectable className="handle-out" />
    </div>
  )
}

export default memo(HttpNode)
