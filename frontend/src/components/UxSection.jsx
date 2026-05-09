export default function UxSection({ step, title, hint, children, className = '' }) {
  return (
    <section className={`ux-section ${className}`.trim()}>
      <div className="ux-section-head">
        {step != null ? (
          <span className="ux-step-badge" aria-hidden="true">
            {step}
          </span>
        ) : null}
        <h2 className="ux-section-title">{title}</h2>
      </div>
      {hint ? <p className="ux-section-hint">{hint}</p> : null}
      {children}
    </section>
  )
}
