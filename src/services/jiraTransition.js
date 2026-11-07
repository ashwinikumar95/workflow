const MAX_HOPS = 6;
const RESOLUTION_PREFER = ["won't do", "wont do", "won't fix", "incomplete", "blocked"];

function normName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function namesMatch(a, b) {
  const left = normName(a);
  return Boolean(left) && left === normName(b);
}

function isCloseName(a, b) {
  const left = normName(a);
  const right = normName(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (!longer.includes(shorter)) return false;
  return shorter.includes(" ") || shorter.length >= 8;
}

function statusNames(statuses) {
  if (!Array.isArray(statuses)) return [];
  return statuses
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && item.name != null) return String(item.name);
      return "";
    })
    .filter(Boolean);
}

function resolveStatusName(want, statuses) {
  const target = normName(want);
  if (!target) return "";
  const names = statusNames(statuses);
  const exact = names.find((name) => normName(name) === target);
  if (exact) return exact;
  const close = names.filter((name) => isCloseName(name, target));
  if (close.length === 1) return close[0];
  return "";
}

function alreadyInStatus(current, target, statuses) {
  if (namesMatch(current, target)) return true;
  const pool = statusNames(statuses).length ? statuses : current ? [{ name: current }] : [];
  const resolved = resolveStatusName(target, pool);
  return Boolean(resolved && namesMatch(current, resolved));
}

function matchTransition(transitions, statusName, statuses) {
  const list = Array.isArray(transitions) ? transitions : [];
  const pool = statusNames(statuses).length ? statuses : list.map((item) => item && item.to).filter(Boolean);
  const resolved = resolveStatusName(statusName, pool);
  const want = normName(resolved || statusName);
  if (!want) return null;
  const exactTo = list.find((item) => item && item.to && normName(item.to) === want);
  if (exactTo) return exactTo;
  const exactName = list.find((item) => item && item.name && normName(item.name) === want);
  if (exactName) return exactName;
  const closeTo = list.filter((item) => item && item.to && isCloseName(item.to, want));
  if (closeTo.length === 1) return closeTo[0];
  return null;
}

function isPreferred(name, preferredStatuses) {
  const n = normName(name);
  if (!n) return false;
  const list = Array.isArray(preferredStatuses) ? preferredStatuses : [];
  return list.some((item) => isCloseName(item, n) || namesMatch(item, n));
}

function lookupStatus(ref, byRef, byId, byName) {
  if (ref == null) return null;
  if (typeof ref === "object") {
    return (
      lookupStatus(ref.statusReference, byRef, byId, byName) ||
      lookupStatus(ref.id, byRef, byId, byName) ||
      lookupStatus(ref.name, byRef, byId, byName)
    );
  }
  const key = String(ref);
  return byRef.get(key) || byId.get(key) || byName.get(normName(key)) || null;
}

function rememberStatus(item, statuses, byRef, byId, byName) {
  if (!item || typeof item !== "object") {
    const name = String(item || "");
    if (!name) return null;
    const status = { id: "", name, ref: name };
    statuses.push(status);
    byName.set(normName(name), status);
    return status;
  }
  const name = item.name != null ? String(item.name) : "";
  const id = item.id != null ? String(item.id) : "";
  const ref = item.statusReference != null ? String(item.statusReference) : id || name;
  const existing = lookupStatus(ref, byRef, byId, byName) || lookupStatus(id, byRef, byId, byName) || lookupStatus(name, byRef, byId, byName);
  if (existing) {
    if (name && !existing.name) existing.name = name;
    if (id && !existing.id) existing.id = id;
    if (ref && !existing.ref) existing.ref = ref;
    return existing;
  }
  const status = { id, name, ref };
  if (name) {
    statuses.push(status);
    byName.set(normName(name), status);
  }
  if (ref) byRef.set(ref, status);
  if (id) byId.set(id, status);
  return status;
}

function parseWorkflowPayload(data) {
  const raw = data && typeof data === "object" ? data : {};
  const statuses = [];
  const byRef = new Map();
  const byId = new Map();
  const byName = new Map();

  const topStatuses = Array.isArray(raw.statuses) ? raw.statuses : [];
  for (const item of topStatuses) rememberStatus(item, statuses, byRef, byId, byName);

  let workflows = [];
  if (Array.isArray(raw.workflows)) workflows = raw.workflows;
  else if (Array.isArray(raw.values)) workflows = raw.values;
  else if (Array.isArray(raw.transitions)) {
    workflows = [{ statuses: raw.statuses || [], transitions: raw.transitions }];
  }

  const transitions = [];
  for (const workflow of workflows) {
    if (!workflow || typeof workflow !== "object") continue;
    if (Array.isArray(workflow.statuses)) {
      for (const item of workflow.statuses) rememberStatus(item, statuses, byRef, byId, byName);
    }
    const list = Array.isArray(workflow.transitions) ? workflow.transitions : [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const type = String(item.type || "").toUpperCase();
      if (type === "INITIAL") continue;
      const toStatus =
        lookupStatus(item.to, byRef, byId, byName) ||
        rememberStatus(
          typeof item.to === "string" ? { name: item.to } : item.to,
          statuses,
          byRef,
          byId,
          byName
        );
      const toName = toStatus && toStatus.name ? toStatus.name : "";
      if (!toName) continue;
      const fromRaw = Array.isArray(item.from) ? item.from : [];
      const fromNames = [];
      for (const from of fromRaw) {
        const fromStatus =
          lookupStatus(from, byRef, byId, byName) ||
          rememberStatus(typeof from === "string" ? { name: from } : from, statuses, byRef, byId, byName);
        if (fromStatus && fromStatus.name) fromNames.push(fromStatus.name);
      }
      if (!fromNames.length) continue;
      transitions.push({
        id: item.id != null ? String(item.id) : "",
        name: item.name != null ? String(item.name) : "",
        from: fromNames,
        to: toName,
      });
    }
  }

  const unique = [];
  const seen = new Set();
  for (const status of statuses) {
    const key = normName(status.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(status);
  }
  return { statuses: unique, transitions };
}

function buildAdjacency(workflow) {
  const edges = new Map();
  const list = workflow && Array.isArray(workflow.transitions) ? workflow.transitions : [];
  for (const item of list) {
    if (!item || !item.to) continue;
    const fromList = Array.isArray(item.from) ? item.from : [];
    for (const from of fromList) {
      const key = normName(from);
      if (!key) continue;
      if (!edges.has(key)) edges.set(key, []);
      edges.get(key).push({
        id: item.id != null ? String(item.id) : "",
        name: item.name != null ? String(item.name) : "",
        from,
        to: item.to,
      });
    }
  }
  return edges;
}

function findTransitionPath(workflow, fromStatus, toStatus, options = {}) {
  const statuses = workflow && Array.isArray(workflow.statuses) ? workflow.statuses : [];
  const from = resolveStatusName(fromStatus, statuses) || fromStatus;
  const to = resolveStatusName(toStatus, statuses) || toStatus;
  if (!normName(from) || !normName(to) || namesMatch(from, to)) return [];

  const preferred = options.preferredStatuses || [];
  const maxHops =
    Number.isInteger(options.maxHops) && options.maxHops > 0 ? options.maxHops : MAX_HOPS;
  const adj = buildAdjacency(workflow);
  const start = normName(from);
  const goal = normName(to);
  const queue = [{ at: start, hops: [] }];
  const seen = new Set([start]);

  while (queue.length) {
    const cur = queue.shift();
    if (cur.hops.length >= maxHops) continue;
    const neighbors = (adj.get(cur.at) || []).slice().sort((a, b) => {
      const pa = isPreferred(a.to, preferred) ? 0 : 1;
      const pb = isPreferred(b.to, preferred) ? 0 : 1;
      return pa - pb;
    });
    for (const edge of neighbors) {
      const next = normName(edge.to);
      if (!next || seen.has(next)) continue;
      const hops = cur.hops.concat(edge);
      if (next === goal || namesMatch(edge.to, to)) return hops;
      seen.add(next);
      queue.push({ at: next, hops });
    }
  }
  return [];
}

function allowedPayload(item, type) {
  if (item == null) return undefined;
  if (typeof item !== "object") return item;
  if (type === "option") {
    if (item.id != null) return { id: String(item.id) };
    if (item.value != null) return { value: item.value };
  }
  if (item.id != null) return { id: String(item.id) };
  if (item.name != null) return { name: item.name };
  if (item.value != null) return { value: item.value };
  return item;
}

function pickAllowed(allowed, preferNames) {
  if (!Array.isArray(allowed) || !allowed.length) return null;
  if (Array.isArray(preferNames) && preferNames.length) {
    const hit = allowed.find((item) => {
      const label = normName((item && (item.name || item.value)) || "");
      return preferNames.some((want) => label === normName(want));
    });
    if (hit) return hit;
  }
  return allowed[0];
}

function schemaType(meta) {
  const schema = meta && meta.schema && typeof meta.schema === "object" ? meta.schema : {};
  return {
    type: String(schema.type || "").toLowerCase(),
    items: String(schema.items || "").toLowerCase(),
    custom: String(schema.custom || "").toLowerCase(),
  };
}

function defaultFieldValue(key, meta, comment, deps = {}) {
  const { type, items, custom } = schemaType(meta);
  const allowed = Array.isArray(meta && meta.allowedValues) ? meta.allowedValues : [];
  if (key === "assignee" || type === "user") {
    const me = deps.myself && typeof deps.myself === "object" ? deps.myself : {};
    if (me.accountId) return { accountId: String(me.accountId) };
    if (me.emailAddress) return { emailAddress: String(me.emailAddress) };
    return undefined;
  }
  if (allowed.length) {
    const prefer = key === "resolution" || type === "resolution" ? RESOLUTION_PREFER : null;
    const picked = pickAllowed(allowed, prefer);
    if (!picked) return undefined;
    if (type === "array") {
      const itemType = items || "option";
      const value = allowedPayload(picked, itemType);
      return value === undefined ? undefined : [value];
    }
    return allowedPayload(picked, type === "option" ? "option" : type);
  }
  if (
    type === "string" ||
    type === "textarea" ||
    custom.includes("textarea") ||
    custom.includes("textfield")
  ) {
    const text = String(comment || "").trim();
    return text || undefined;
  }
  return undefined;
}

function fillRequiredFields(fieldSchema, deps = {}) {
  const schema = fieldSchema && typeof fieldSchema === "object" && !Array.isArray(fieldSchema) ? fieldSchema : {};
  const overlay =
    deps.transitionFields && typeof deps.transitionFields === "object" && !Array.isArray(deps.transitionFields)
      ? deps.transitionFields
      : {};
  const comment = String(deps.commentText || deps.reason || "").trim();
  const fields = {};
  const missing = [];
  let needsComment = false;

  const keys = new Set([...Object.keys(schema), ...Object.keys(overlay)]);
  for (const key of keys) {
    const meta = schema[key];
    if (key === "comment") {
      if (meta && meta.required) needsComment = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(overlay, key)) {
      fields[key] = overlay[key];
      continue;
    }
    if (!meta || !meta.required) continue;
    const value = defaultFieldValue(key, meta, comment, deps);
    if (value === undefined) missing.push(key);
    else fields[key] = value;
  }
  return { fields, missing, needsComment };
}

function missingFieldsFromError(err) {
  const data = err && err.response && err.response.data;
  if (!data || typeof data !== "object") return [];
  const errors = data.errors && typeof data.errors === "object" ? data.errors : {};
  return Object.keys(errors).filter(Boolean);
}

function formatOffered(transitions) {
  return (Array.isArray(transitions) ? transitions : [])
    .map((item) => {
      if (!item) return "";
      if (item.name && item.to) return `${item.name} → ${item.to}`;
      return item.to || item.name || "";
    })
    .filter(Boolean)
    .join("; ");
}

function formatHops(hops) {
  return (Array.isArray(hops) ? hops : [])
    .map((item) => (item && item.to) || "")
    .filter(Boolean)
    .join(" → ");
}

module.exports = {
  MAX_HOPS,
  normName,
  namesMatch,
  isCloseName,
  alreadyInStatus,
  resolveStatusName,
  matchTransition,
  findTransitionPath,
  parseWorkflowPayload,
  fillRequiredFields,
  defaultFieldValue,
  missingFieldsFromError,
  formatOffered,
  formatHops,
};
