import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { workflowApi } from '../lib/api'

export default function Dashboard() {
  const navigate = useNavigate()
  const [workflows, setWorkflows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setError('')
    setLoading(true)
    try {
      const { data } = await workflowApi.list()
      setWorkflows(data)
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load workflows')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function handleCreate() {
    setCreating(true)
    setError('')
    try {
      const { data } = await workflowApi.create({
        name: 'Untitled workflow',
        status: 'draft',
        nodes: [],
        edges: [],
      })
      navigate(`/workflows/${data._id}`)
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Could not create workflow')
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete(id, e) {
    e.preventDefault()
    e.stopPropagation()
    if (!window.confirm('Delete this workflow?')) return
    try {
      await workflowApi.delete(id)
      setWorkflows((w) => w.filter((x) => x._id !== id))
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Delete failed')
    }
  }

  return (
    <div className="dashboard">
      <div className="page-header">
        <div>
          <h1>Your workflows</h1>
          <p className="muted page-header-lead">
            Each workflow is a small diagram of steps. Open one to build, <strong>Save</strong> your draft, then{' '}
            <strong>Publish</strong> when you want webhooks, schedules, or run history.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={handleCreate} disabled={creating}>
          {creating ? 'Creating…' : 'New workflow'}
        </button>
      </div>

      {error ? <div className="alert alert-error">{error}</div> : null}

      {loading ? (
        <div className="page-center">
          <div className="spinner" />
        </div>
      ) : workflows.length === 0 ? (
        <div className="empty-state empty-state-rich">
          <h2 className="empty-state-title">Nothing here yet</h2>
          <p className="muted empty-state-text">
            You will draw steps on a canvas, connect them, and choose how the workflow starts (webhook or schedule).
          </p>
          <ol className="empty-steps">
            <li>Click <strong>New workflow</strong> below.</li>
            <li>Add steps and connect the dots on the board.</li>
            <li>Save, then Publish when the diagram is ready.</li>
          </ol>
          <button type="button" className="btn btn-primary" onClick={handleCreate}>
            Create your first workflow
          </button>
        </div>
      ) : (
        <ul className="workflow-grid">
          {workflows.map((w) => (
            <li key={w._id}>
              <div
                className="workflow-card"
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/workflows/${w._id}`)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    navigate(`/workflows/${w._id}`)
                  }
                }}
              >
                <div className="workflow-card-top">
                  <h2>{w.name}</h2>
                  <span className={`badge badge-${w.status === 'published' ? 'ok' : 'muted'}`}>
                    {w.status}
                  </span>
                </div>
                <p className="muted small">
                  Trigger: {w.trigger?.type || 'none'}
                  {w.trigger?.enabled === false ? ' (paused)' : ''} · {w.nodes?.length || 0} nodes ·{' '}
                  <button
                    type="button"
                    className="inline-link"
                    onClick={(e) => {
                      e.stopPropagation()
                      navigate(`/workflows/${w._id}/runs`)
                    }}
                  >
                    Runs
                  </button>
                </p>
                <button
                  type="button"
                  className="btn btn-danger-ghost card-delete"
                  onClick={(e) => handleDelete(w._id, e)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
