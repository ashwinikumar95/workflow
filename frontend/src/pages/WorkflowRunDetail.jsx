import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { runApi } from '../lib/api'

function statusClass(status) {
  if (status === 'success') return 'ok'
  if (status === 'failed' || status === 'cancelled') return 'danger'
  if (status === 'waiting') return 'wait'
  if (status === 'interrupted') return 'interrupted'
  return 'muted'
}

export default function WorkflowRunDetail() {
  const { id, runId } = useParams()
  const [run, setRun] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [decisionError, setDecisionError] = useState('')
  const [deciding, setDeciding] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setLoadError('')
      try {
        const { data } = await runApi.get(runId)
        if (!cancelled) setRun(data)
      } catch (err) {
        if (!cancelled) {
          setLoadError(err.response?.data?.error || err.message || 'Failed to load run')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [runId])

  useEffect(() => {
    if (run?.status !== 'waiting') return undefined
    const timer = setInterval(() => {
      runApi
        .get(runId)
        .then(({ data }) => setRun(data))
        .catch(() => {})
    }, 3000)
    return () => clearInterval(timer)
  }, [run?.status, runId])

  async function decide(decision) {
    setDeciding(true)
    setDecisionError('')
    try {
      const { data } = await runApi.decide(runId, decision)
      setRun(data)
    } catch (err) {
      setDecisionError(err.response?.data?.error || err.message || 'Decision failed')
    } finally {
      setDeciding(false)
    }
  }

  if (loading) {
    return (
      <div className="page-center">
        <div className="spinner" />
      </div>
    )
  }

  if (loadError || !run) {
    return (
      <div className="runs-page">
        <div className="alert alert-error">{loadError || 'Not found'}</div>
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
        <span className={`badge badge-${statusClass(run.status)}`}>{run.status}</span>{' '}
        · jobId: {run.jobId}
      </p>
      <p className="muted small">
        Started: {run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'} · Ended:{' '}
        {run.endedAt ? new Date(run.endedAt).toLocaleString() : '—'}
      </p>

      {decisionError ? <div className="alert alert-error">{decisionError}</div> : null}

      {run.external?.prUrl ? (
        <p>
          Pull request:{' '}
          <a href={run.external.prUrl} target="_blank" rel="noreferrer">
            {run.external.prUrl}
          </a>
        </p>
      ) : null}

      {run.status === 'waiting' && run.wait?.kind && run.wait.kind !== 'approval' ? (
        <section className="approval-panel">
          <h2>Waiting on {run.wait.kind}</h2>
          <p className="muted">This step finishes when that work settles. This page refreshes every few seconds.</p>
        </section>
      ) : null}

      {run.status === 'waiting' && (!run.wait?.kind || run.wait.kind === 'approval') ? (
        <section className="approval-panel">
          <h2>Waiting for approval</h2>
          {typeof run.context?.prompt === 'string' ? (
            <pre className="code-block approval-prompt">{run.context.prompt}</pre>
          ) : (
            <p className="muted">This run is paused until you approve or reject it.</p>
          )}
          <div className="approval-actions">
            <button type="button" className="btn btn-primary" disabled={deciding} onClick={() => decide('approved')}>
              Approve
            </button>
            <button
              type="button"
              className="btn btn-danger-ghost"
              disabled={deciding}
              onClick={() => decide('rejected')}
            >
              Reject
            </button>
          </div>
        </section>
      ) : null}

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
