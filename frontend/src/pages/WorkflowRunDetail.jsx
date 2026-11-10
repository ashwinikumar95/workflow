import { Fragment, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { runApi } from '../lib/api'
import {
  approvalSubject,
  asPlan,
  displayLogStatus,
  displayRunStatus,
  enrichLogFacts,
  formatLogRaw,
  isApprovalWait,
  isResuming,
  promptFromContext,
  rawPreview,
  ticketFromContext,
  waitingKind,
  waitingTitle,
} from '../lib/runLogDisplay'

function FactList({ facts }) {
  if (!facts.length) return null
  return (
    <dl className="run-facts">
      {facts.map((fact) => (
        <Fragment key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </Fragment>
      ))}
    </dl>
  )
}

function RulesList({ rules }) {
  if (!Array.isArray(rules) || !rules.length) return null
  return (
    <div className="rules-block">
      <h3>Rules applied</h3>
      <ul>
        {rules.map((rule, i) => {
          const file = typeof rule === 'string' ? rule : rule.file || rule.how || 'rule'
          const reason = typeof rule === 'object' && rule && rule.reason ? ` (${rule.reason})` : ''
          return (
            <li key={i}>
              {file}
              {reason}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function PlanBlock({ plan, planHash }) {
  if (!plan) return null
  return (
    <div className="plan-block">
      <h3>Plan to approve</h3>
      {planHash ? <p className="muted small">planHash: {planHash}</p> : null}
      {plan.approach ? <p>{plan.approach}</p> : null}
      {Array.isArray(plan.filesToChange) && plan.filesToChange.length ? (
        <p className="muted small">Files: {plan.filesToChange.join(', ')}</p>
      ) : null}
      {Array.isArray(plan.modules) && plan.modules.length ? (
        <p className="muted small">Modules: {plan.modules.join(', ')}</p>
      ) : null}
      {Array.isArray(plan.testsToRunOrWrite) && plan.testsToRunOrWrite.length ? (
        <p className="muted small">Tests: {plan.testsToRunOrWrite.join(', ')}</p>
      ) : null}
      {Array.isArray(plan.risks) && plan.risks.length ? (
        <p className="muted small">Risks: {plan.risks.join(', ')}</p>
      ) : null}
      {Array.isArray(plan.questions) && plan.questions.length ? (
        <p className="muted small">Questions: {plan.questions.join(', ')}</p>
      ) : null}
    </div>
  )
}

function PromptBlock({ prompt, heading }) {
  if (!prompt) return null
  return (
    <div className="plan-block">
      <h3>{heading}</h3>
      <pre className="code-block approval-prompt approval-prompt-scroll">{prompt}</pre>
    </div>
  )
}

export default function WorkflowRunDetail() {
  const { id, runId } = useParams()
  const [run, setRun] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [decisionError, setDecisionError] = useState('')
  const [deciding, setDeciding] = useState(false)
  const [controlError, setControlError] = useState('')
  const [controlling, setControlling] = useState(false)
  const [answers, setAnswers] = useState([])

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
    if (run?.status !== 'waiting' && run?.status !== 'running') return undefined
    const timer = setInterval(() => {
      runApi
        .get(runId)
        .then(({ data }) => setRun(data))
        .catch(() => {})
    }, 3000)
    return () => clearInterval(timer)
  }, [run?.status, runId])

  const planQuestions =
    run?.wait?.nodeId === 'approvePlan' && Array.isArray(run?.context?.plan?.questions)
      ? run.context.plan.questions.filter((question) => typeof question === 'string' && question.trim())
      : []
  const questionKey = JSON.stringify(planQuestions)

  useEffect(() => {
    const list = JSON.parse(questionKey)
    setAnswers(list.map(() => ''))
  }, [run?._id, run?.wait?.nodeId, questionKey])

  async function decide(decision) {
    setDeciding(true)
    setDecisionError('')
    try {
      const planHash = typeof run?.context?.planHash === 'string' ? run.context.planHash : undefined
      const answersToSend = decision === 'approved' && planQuestions.length ? answers : undefined
      const { data } = await runApi.decide(runId, decision, planHash, answersToSend)
      setRun(data)
    } catch (err) {
      setDecisionError(err.response?.data?.error || err.message || 'Decision failed')
    } finally {
      setDeciding(false)
    }
  }

  async function control(action) {
    setControlling(true)
    setControlError('')
    try {
      const { data } = action === 'cancel' ? await runApi.cancel(runId) : await runApi.retry(runId)
      setRun(data)
    } catch (err) {
      setControlError(err.response?.data?.error || err.message || `${action} failed`)
    } finally {
      setControlling(false)
    }
  }

  const canCancel = run && ['running', 'waiting', 'interrupted', 'failed'].includes(run.status)
  const canRetry = run && ['interrupted', 'failed'].includes(run.status)
  const ticket = ticketFromContext(run?.context)
  const plan = asPlan(run?.context?.plan)
  const prompt = promptFromContext(run?.context)
  const outcome = displayRunStatus(run)
  const waiting = run && run.status === 'waiting'
  const approvalWait = isApprovalWait(run)
  const resuming = isResuming(run)
  const canDecide = Boolean(waiting && approvalWait && !resuming)
  const kind = waitingKind(run)
  const rulesApplied =
    (Array.isArray(run?.context?.rulesApplied) && run.context.rulesApplied) ||
    (Array.isArray(run?.context?.rulesManifest?.rulesApplied) && run.context.rulesManifest.rulesApplied) ||
    []
  const promptHeading =
    run?.context?.agentMode === 'implement' || run?.context?.agentMode === 'fix'
      ? 'Cursor prompt for the code changes'
      : run?.context?.agentMode === 'plan'
        ? 'Cursor prompt used to write this plan'
        : 'Cursor prompt'

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
        <span className={`badge badge-${outcome.className}`}>{outcome.label}</span>{' '}
        · jobId: <span className="job-id">{run.jobId}</span>
      </p>
      <p className="muted small">
        Started: {run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'} · Ended:{' '}
        {run.endedAt ? new Date(run.endedAt).toLocaleString() : '—'}
      </p>
      {outcome.status === 'failed' && (outcome.reason || outcome.title) ? (
        <section className="outcome-card outcome-failed">
          <h2>{outcome.title || 'Run failed'}</h2>
          {outcome.reason ? <p>{outcome.reason}</p> : null}
        </section>
      ) : null}

      {waiting && !approvalWait && kind === 'agent' ? (
        <section className="approval-panel">
          <h2>
            {run.wait?.nodeId === 'agentImpl'
              ? 'Waiting on the implementation agent'
              : 'Waiting on the plan agent'}
          </h2>
          <p className="muted small">
            Keep <code className="inline-code">npm run worker:agent</code> running. This page refreshes
            every few seconds. Approve / Reject appear only when the run reaches an approval step.
          </p>
        </section>
      ) : null}

      {waiting && !approvalWait && kind === 'playwright' ? (
        <section className="approval-panel">
          <h2>Waiting on Playwright</h2>
          <p className="muted small">Playwright is running. This page refreshes every few seconds.</p>
        </section>
      ) : null}

      {waiting && approvalWait ? (
        <section className="approval-panel sticky-approval">
          <h2>{waitingTitle(run)}</h2>
          {resuming ? (
            <p className="muted">
              {run.approval.decision === 'approved'
                ? 'Approved. The run is resuming from this step.'
                : 'Rejected. The run is resuming on the stop path.'}
            </p>
          ) : (
            <p className="muted">{approvalSubject(run)}</p>
          )}
          <PlanBlock plan={plan} planHash={run.context?.planHash} />
          <PromptBlock prompt={prompt} heading={promptHeading} />
          <RulesList rules={rulesApplied} />
          {Array.isArray(run.context?.review?.uncertainties) && run.context.review.uncertainties.length ? (
            <div className="rules-block">
              <h3>Review uncertainties</h3>
              <ul>
                {run.context.review.uncertainties.map((item, i) => (
                  <li key={i}>
                    {item.rule}: {item.question}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {!plan && !prompt && !resuming ? (
            <p className="muted">This run is paused until you approve or reject it.</p>
          ) : null}
          {planQuestions.length ? (
            <div className="rules-block">
              <h3>Questions to answer</h3>
              <p className="muted small">The run stays paused until each question has an answer.</p>
              {planQuestions.map((question, index) => (
                <label className="field" key={`${index}-${question}`}>
                  <span>{question}</span>
                  <textarea
                    rows={3}
                    value={answers[index] || ''}
                    onChange={(event) => {
                      const next = planQuestions.map((_, i) => answers[i] || '')
                      next[index] = event.target.value
                      setAnswers(next)
                    }}
                  />
                </label>
              ))}
            </div>
          ) : null}
          <div className="approval-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                deciding ||
                !canDecide ||
                planQuestions.some((_, index) => !String(answers[index] || '').trim())
              }
              title={canDecide ? 'Approve and resume this run' : 'Available when this step asks for approval'}
              onClick={() => decide('approved')}
            >
              {deciding ? 'Saving…' : 'Approve'}
            </button>
            <button
              type="button"
              className="btn btn-danger-ghost"
              disabled={deciding || !canDecide}
              title={canDecide ? 'Reject and stop this path' : 'Available when this step asks for approval'}
              onClick={() => decide('rejected')}
            >
              Reject
            </button>
          </div>
        </section>
      ) : null}

      {ticket ? (
        <section className="ticket-card">
          <h2>Ticket</h2>
          <dl className="run-facts">
            {ticket.issueKey ? (
              <>
                <dt>Key</dt>
                <dd>{ticket.issueKey}</dd>
              </>
            ) : null}
            {ticket.summary ? (
              <>
                <dt>Summary</dt>
                <dd>{ticket.summary}</dd>
              </>
            ) : null}
            {ticket.status ? (
              <>
                <dt>Status</dt>
                <dd>{ticket.status}</dd>
              </>
            ) : null}
          </dl>
        </section>
      ) : null}

      {decisionError ? <div className="alert alert-error">{decisionError}</div> : null}
      {controlError ? <div className="alert alert-error">{controlError}</div> : null}

      {canCancel || canRetry ? (
        <div className="approval-actions">
          {canCancel ? (
            <button
              type="button"
              className="btn btn-danger-ghost"
              disabled={controlling}
              onClick={() => control('cancel')}
            >
              {run.status === 'failed' ? 'Stop ticket lock' : 'Cancel'}
            </button>
          ) : null}
          {canRetry ? (
            <button type="button" className="btn btn-secondary" disabled={controlling} onClick={() => control('retry')}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {run.external?.prUrl ? (
        <p>
          Pull request:{' '}
          <a href={run.external.prUrl} target="_blank" rel="noreferrer">
            {run.external.prUrl}
          </a>
        </p>
      ) : null}

      <h2>Step logs</h2>
      {run.logs?.length ? (
        <ol className="run-logs run-logs-scroll">
          {run.logs.map((log, i) => {
            const facts = enrichLogFacts(log, run)
            const raw = formatLogRaw(log.output) || formatLogRaw(log.input) || rawPreview(log.output) || rawPreview(log.input)
            const step = displayLogStatus(log, run)
            return (
              <li key={i} className="run-log-item">
                <div className="run-log-head">
                  <strong className="run-log-title">{log.nodeId || log.status || 'step'}</strong>
                  <span className={`badge badge-${step.className}`}>{step.label}</span>
                  {log.duration != null ? <span className="muted run-log-duration">{log.duration} ms</span> : null}
                </div>
                {log.error ? <div className="alert alert-error tight">{log.error}</div> : null}
                <FactList facts={facts} />
                {raw ? (
                  <details className="run-log-raw" open={!facts.length}>
                    <summary>{facts.length ? 'Step data' : 'Details'}</summary>
                    <pre className="code-block small">{raw}</pre>
                  </details>
                ) : null}
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="muted">No step logs.</p>
      )}
    </div>
  )
}
