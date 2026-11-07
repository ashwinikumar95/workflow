import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'

function ApprovalNode({ data, selected }) {
  const title = data?.config?.title || 'Approval'

  return (
    <div className={`canvas-node approval-node${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable className="handle-in" />
      <div className="canvas-node-badge">APPROVAL</div>
      <div className="canvas-node-title">{title}</div>
      <div className="canvas-node-url">Wait for a person</div>
      <div className="approval-handles">
        <span>Approve</span>
        <span>Reject</span>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        id="true"
        isConnectable
        className="handle-out handle-true"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="false"
        isConnectable
        className="handle-out handle-false"
      />
    </div>
  )
}

export default memo(ApprovalNode)
