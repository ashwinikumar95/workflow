import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { runApi } from '../lib/api'

export default function WorkflowRunDetail() {
  const { id, runId } = useParams()
  const [run, setRun] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError('')
      try {
        const { data } = await runApi.get(runId)
        if (!cancelled) setRun(data)
      } catch (err) {
        if (!cancelled) {
          setError(err.response?.data?.error || err.message || 'Failed to load run')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [runId])

  if (loading) {
    return (
      <div className="page-center">
        <div className="spinner" />
      </div>
    )
  }

  if (error || !run) {
    return (
      <div className="runs-page">
        <div className="alert alert-error">{error || 'Not found'}</div>
        <Link to={`/workflows/${id}/runs`}>Back to runs</Link>
      </div>
    )
  }

  return (
    <div className="runs-page dashboard">
      <Link to={`/workflows/${id}/runs`} className="back-link">
        ← All runs
      </Link>
      <h1>Run detail</h1>
      <p className="muted">
        <span className={`badge badge-${run.status === 'success' ? 'ok' : run.status === 'failed' ? 'danger' : 'muted'}`}>
          {run.status}
        </span>{' '}
        · jobId: {run.jobId}
      </p>
      <p className="muted small">
        Started: {run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'} · Ended:{' '}
        {run.endedAt ? new Date(run.endedAt).toLocaleString() : '—'}
      </p>

      <h2>Step logs</h2>
      {run.logs?.length ? (
        <ol className="run-logs">
          {run.logs.map((log, i) => (
            <li key={i} className="run-log-item">
              <strong>{log.nodeId || log.status || 'step'}</strong> — {log.status}
              {log.duration != null ? ` (${log.duration} ms)` : ''}
              {log.error ? <div className="alert alert-error tight">{log.error}</div> : null}
              {log.input != null ? (
                <pre className="code-block small">{String(log.input).slice(0, 500)}</pre>
              ) : null}
              {log.output != null ? (
                <pre className="code-block small">{String(log.output).slice(0, 500)}</pre>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">No step logs.</p>
      )}
    </div>
  )
}
