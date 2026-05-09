import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'

function ConditionNode({ data, selected }) {
  const op = data?.config?.operator || 'truthy'
  const field = data?.config?.field || '(input)'

  return (
    <div className={`canvas-node condition-node${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable className="handle-in" />
      <div className="canvas-node-badge">IF</div>
      <div className="canvas-node-title">Condition</div>
      <div className="canvas-node-method">{op}</div>
      <div className="canvas-node-url" title={field}>
        {field || 'truthy'}
      </div>
      <Handle type="source" position={Position.Bottom} id="out" isConnectable className="handle-out" />
    </div>
  )
}

export default memo(ConditionNode)
