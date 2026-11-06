import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'

function TestSelectNode({ data, selected }) {
  const title = data?.config?.title || 'Test select'
  const mode = data?.config?.mode || ''
  const summary = mode === 'automation' ? 'Automation specs and tags' : mode === 'app' ? 'App modules from the diff' : 'Select Playwright tests'
  return (
    <div className={`canvas-node${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable className="handle-in" />
      <div className="canvas-node-badge">TESTS</div>
      <div className="canvas-node-title">{title}</div>
      <div className="canvas-node-url">{summary}</div>
      <Handle type="source" position={Position.Bottom} id="out" isConnectable className="handle-out" />
    </div>
  )
}

export default memo(TestSelectNode)
