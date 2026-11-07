import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'

function RulesChecksNode({ data, selected }) {
  const title = data?.config?.title || 'Rules checks'
  return (
    <div className={`canvas-node branch-node${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable className="handle-in" />
      <div className="canvas-node-badge">RULES</div>
      <div className="canvas-node-title">{title}</div>
      <div className="canvas-node-url">Mechanical checks on the diff</div>
      <div className="approval-handles">
        <span>Passed</span>
        <span>Failed</span>
      </div>
      <Handle type="source" position={Position.Bottom} id="true" isConnectable className="handle-out handle-true" />
      <Handle type="source" position={Position.Bottom} id="false" isConnectable className="handle-out handle-false" />
    </div>
  )
}

export default memo(RulesChecksNode)
