import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'

function NotifyNode({ data, selected }) {
  const msg = data?.config?.message || 'Notification'
  const short = msg.length > 36 ? `${msg.slice(0, 34)}…` : msg

  return (
    <div className={`canvas-node notify-node${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable className="handle-in" />
      <div className="canvas-node-badge">MSG</div>
      <div className="canvas-node-title">Notify</div>
      <div className="canvas-node-method">Slack</div>
      <div className="canvas-node-url" title={msg}>
        {short}
      </div>
      <Handle type="source" position={Position.Bottom} id="out" isConnectable className="handle-out" />
    </div>
  )
}

export default memo(NotifyNode)
