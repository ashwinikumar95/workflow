/**
 * Maps between datetime-local values and 5-field cron strings (node-cron),
 * for simple daily / yearly schedules only. Other expressions stay in "advanced" mode.
 */

function pad2(n) {
  return String(n).padStart(2, '0')
}

export function formatDatetimeLocalFromParts({ year, month, day, hour, minute }) {
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}`
}

export function formatDatetimeLocalFromDate(d) {
  return formatDatetimeLocalFromParts({
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
  })
}

/** Next sensible default: 9:00 local, or tomorrow 9:00 if that time already passed today. */
export function defaultCronDatetimeLocal() {
  const d = new Date()
  d.setSeconds(0, 0)
  d.setMilliseconds(0)
  d.setHours(9, 0, 0, 0)
  if (d.getTime() <= Date.now()) {
    d.setDate(d.getDate() + 1)
  }
  return formatDatetimeLocalFromDate(d)
}

export function parseDatetimeLocal(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec((str || '').trim())
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hour = Number(m[4])
  const minute = Number(m[5])
  if (
    !Number.isFinite(year) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59
  ) {
    return null
  }
  return { year, month, day, hour, minute }
}

function validClock(minute, hour) {
  return (
    Number.isFinite(minute) &&
    Number.isFinite(hour) &&
    minute >= 0 &&
    minute <= 59 &&
    hour >= 0 &&
    hour <= 23
  )
}

/**
 * @returns {{ repeat: 'daily' | 'yearly', minutes: number, hours: number, dom?: number, month?: number } | null}
 */
export function parseCronForPicker(cronStr) {
  if (typeof cronStr !== 'string') return null
  const c = cronStr.trim()
  if (!c) return null

  const daily = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(c)
  if (daily) {
    const minutes = Number(daily[1])
    const hours = Number(daily[2])
    if (!validClock(minutes, hours)) return null
    return { repeat: 'daily', minutes, hours }
  }

  const yearly = /^(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+\*$/.exec(c)
  if (yearly) {
    const minutes = Number(yearly[1])
    const hours = Number(yearly[2])
    const dom = Number(yearly[3])
    const month = Number(yearly[4])
    if (!validClock(minutes, hours)) return null
    if (!Number.isFinite(dom) || dom < 1 || dom > 31) return null
    if (!Number.isFinite(month) || month < 1 || month > 12) return null
    return { repeat: 'yearly', minutes, hours, dom, month }
  }

  return null
}

export function parsedCronToDatetimeLocal(parsed) {
  const now = new Date()
  const y = now.getFullYear()
  if (parsed.repeat === 'daily') {
    const d = new Date(y, now.getMonth(), now.getDate(), parsed.hours, parsed.minutes, 0, 0)
    return formatDatetimeLocalFromDate(d)
  }
  const d = new Date(y, parsed.month - 1, parsed.dom, parsed.hours, parsed.minutes, 0, 0)
  return formatDatetimeLocalFromDate(d)
}

/**
 * @param {string} datetimeLocal - YYYY-MM-DDTHH:mm
 * @param {'daily' | 'yearly'} repeat
 */
export function buildCronFromPicker(datetimeLocal, repeat) {
  const p = parseDatetimeLocal(datetimeLocal)
  if (!p) return `0 9 * * *`
  if (repeat === 'daily') {
    return `${p.minute} ${p.hour} * * *`
  }
  return `${p.minute} ${p.hour} ${p.day} ${p.month} *`
}
