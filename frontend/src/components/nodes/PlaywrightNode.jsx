import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'

function PlaywrightNode({ data, selected }) {
  const strategy = data?.config?.strategy || 'Choose tests'
  return (
    <div className={`canvas-node branch-node${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable className="handle-in" />
      <div className="canvas-node-badge">PLAYWRIGHT</div>
      <div className="canvas-node-title">{data?.config?.title || 'Playwright'}</div>
      <div className="canvas-node-url">{strategy}</div>
      <div className="approval-handles">
        <span>Passed</span>
        <span>Failed</span>
      </div>
      <Handle type="source" position={Position.Bottom} id="true" isConnectable className="handle-out handle-true" />
      <Handle type="source" position={Position.Bottom} id="false" isConnectable className="handle-out handle-false" />
    </div>
  )
}

export default memo(PlaywrightNode)
