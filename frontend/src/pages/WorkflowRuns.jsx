import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { workflowApi } from '../lib/api'

export default function WorkflowRuns() {
  const { id } = useParams()
  const [runs, setRuns] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const limit = 15

  const load = useCallback(async () => {
    setError('')
    setLoading(true)
    try {
      const { data } = await workflowApi.runs(id, { page, limit })
      setRuns(data.runs || [])
      setTotal(data.total ?? 0)
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load runs')
    } finally {
      setLoading(false)
    }
  }, [id, page])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="runs-page dashboard">
      <div className="page-header">
        <div>
          <Link to={`/workflows/${id}`} className="back-link">
            ← Back to editor
          </Link>
          <h1>Run history</h1>
          <p className="muted page-header-lead">
            Each line is one execution. Open a run to see which steps ran and any errors.
          </p>
        </div>
      </div>

      {error ? <div className="alert alert-error">{error}</div> : null}

      {loading ? (
        <div className="page-center">
          <div className="spinner" />
        </div>
      ) : runs.length === 0 ? (
        <div className="empty-state empty-state-rich">
          <h2 className="empty-state-title">No runs yet</h2>
          <p className="muted empty-state-text">
            Runs appear after you <strong>publish</strong> this workflow and either use <strong>Run now</strong> in the
            editor, call the <strong>webhook</strong>, or let <strong>cron</strong> fire.
          </p>
        </div>
      ) : (
        <>
          <ul className="runs-list">
            {runs.map((r) => (
              <li key={r._id}>
                <Link to={`/workflows/${id}/runs/${r._id}`} className="run-row">
                  <span className={`badge badge-${r.status === 'success' ? 'ok' : r.status === 'failed' ? 'danger' : 'muted'}`}>
                    {r.status}
                  </span>
                  <span className="run-meta">
                    {r.jobId ? `job ${r.jobId}` : ''} ·{' '}
                    {r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="pagination">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </button>
            <span className="muted small">
              Page {page} · {total} total
            </span>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={page * limit >= total}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  )
}
