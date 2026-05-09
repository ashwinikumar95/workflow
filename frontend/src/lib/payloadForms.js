/**
 * Flat key → string value rows for headers (values stay strings).
 */
export function headersObjectToRows(h) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) {
    return [{ key: '', value: '' }]
  }
  const entries = Object.entries(h)
  if (entries.length === 0) return [{ key: '', value: '' }]
  return entries.map(([key, value]) => ({ key, value: value == null ? '' : String(value) }))
}

export function rowsToHeadersObject(rows) {
  const o = {}
  for (const { key, value } of rows) {
    const k = String(key).trim()
    if (!k) continue
    o[k] = value == null ? '' : String(value)
  }
  return o
}

/**
 * Body: coerce cell text to boolean / number / JSON / string.
 */
export function rowsToBodyObject(rows) {
  const o = {}
  for (const { key, value } of rows) {
    const k = String(key).trim()
    if (!k) continue
    const t = String(value).trim()
    if (t === 'true') {
      o[k] = true
      continue
    }
    if (t === 'false') {
      o[k] = false
      continue
    }
    if (t === '') {
      o[k] = ''
      continue
    }
    if (!Number.isNaN(Number(t)) && t !== '' && String(Number(t)) === t) {
      o[k] = Number(t)
      continue
    }
    if (
      (t.startsWith('{') && t.endsWith('}')) ||
      (t.startsWith('[') && t.endsWith(']'))
    ) {
      try {
        o[k] = JSON.parse(t)
        continue
      } catch {
        /* fall through */
      }
    }
    o[k] = t
  }
  return o
}

export function bodyObjectToRows(body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return [{ key: '', value: '' }]
  }
  const entries = Object.entries(body)
  if (entries.length === 0) return [{ key: '', value: '' }]
  return entries.map(([key, val]) => ({
    key,
    value:
      val != null && typeof val === 'object'
        ? JSON.stringify(val)
        : val === null
          ? ''
          : String(val),
  }))
}

/** Only plain objects with primitive values — safe for the simple field builder. */
export function isSimpleFlatBody(body) {
  if (body == null) return true
  if (typeof body !== 'object' || Array.isArray(body)) return false
  return Object.values(body).every(
    (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)
  )
}
