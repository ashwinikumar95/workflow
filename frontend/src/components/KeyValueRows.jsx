/**
 * Simple key / value rows — no raw JSON required for users.
 */
export default function KeyValueRows({
  rows,
  onChange,
  disabled,
  keyLabel = 'Name',
  valueLabel = 'Value',
}) {
  const updateRow = (index, field, val) => {
    const next = rows.map((r, i) => (i === index ? { ...r, [field]: val } : r))
    onChange(next)
  }

  const addRow = () => {
    onChange([...rows, { key: '', value: '' }])
  }

  const removeRow = (index) => {
    onChange(rows.filter((_, i) => i !== index))
  }

  return (
    <div className="kv-panel">
      <div className="kv-head">
        <span>{keyLabel}</span>
        <span>{valueLabel}</span>
        <span className="kv-head-actions" />
      </div>
      {rows.map((row, i) => (
        <div key={i} className="kv-row">
          <input
            type="text"
            className="kv-input kv-key"
            placeholder="field"
            value={row.key}
            onChange={(e) => updateRow(i, 'key', e.target.value)}
            disabled={disabled}
            autoComplete="off"
          />
          <input
            type="text"
            className="kv-input kv-val"
            placeholder="value"
            value={row.value}
            onChange={(e) => updateRow(i, 'value', e.target.value)}
            disabled={disabled}
            autoComplete="off"
          />
          <button
            type="button"
            className="kv-remove"
            onClick={() => removeRow(i)}
            disabled={disabled || rows.length <= 1}
            aria-label="Remove row"
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-chip" onClick={addRow} disabled={disabled}>
        + Add field
      </button>
    </div>
  )
}
