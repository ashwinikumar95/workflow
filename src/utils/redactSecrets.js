const SECRET_SEGMENTS = new Set([
  "secret",
  "password",
  "passwd",
  "token",
  "apikey",
  "api_key",
  "accesstoken",
  "access_token",
  "privatekey",
  "private_key",
  "clientsecret",
  "webhooksecret",
]);

const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-webhook-secret",
  "x-auth-token",
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value) || value instanceof Date) return false;
  if (value._bsontype) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function toPlain(doc) {
  if (!doc || typeof doc !== "object") return doc;
  if (typeof doc.toObject === "function") return doc.toObject();
  return doc;
}

function isSecretName(key, inHeaders) {
  const name = String(key).toLowerCase();
  if (inHeaders && SECRET_HEADERS.has(name)) return true;
  return SECRET_SEGMENTS.has(name);
}

function secretPresent(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  return true;
}

/**
 * Omit secret-like values. `trigger.config.secret` becomes `secretSet: boolean`.
 * Other secrets under a `config` object set `config.secretSet[path] = true`.
 */
function walk(value, ctx) {
  if (Array.isArray(value)) {
    return {
      value: value.map(
        (item) =>
          walk(item, {
            parentKey: "",
            inConfig: false,
            triggerConfig: false,
            inHeaders: false,
            path: [],
          }).value
      ),
      indicators: {},
    };
  }
  if (!isPlainObject(value)) return { value, indicators: {} };

  const out = {};
  const indicators = {};
  let triggerSecretSet;

  for (const key of Object.keys(value)) {
    if (key === "secretSet") continue;
    const child = value[key];
    if (isSecretName(key, ctx.inHeaders)) {
      if (ctx.triggerConfig && key.toLowerCase() === "secret") {
        triggerSecretSet = secretPresent(child);
      } else if (ctx.inConfig && secretPresent(child)) {
        indicators[[...ctx.path, key].join(".")] = true;
      }
      continue;
    }

    if (isPlainObject(child) || Array.isArray(child)) {
      const next = walk(child, {
        parentKey: key,
        inConfig: key === "config" ? true : ctx.inConfig,
        triggerConfig: key === "config" && ctx.parentKey === "trigger",
        inHeaders: ctx.inHeaders || key.toLowerCase() === "headers",
        path: key === "config" ? [] : ctx.inConfig ? [...ctx.path, key] : [],
      });
      out[key] = next.value;
      if (ctx.inConfig && key !== "config") Object.assign(indicators, next.indicators);
      continue;
    }

    out[key] = child;
  }

  if (ctx.inConfig && ctx.path.length === 0) {
    if (ctx.triggerConfig) {
      out.secretSet = triggerSecretSet === true;
    } else if (Object.keys(indicators).length > 0) {
      out.secretSet = indicators;
    }
  }

  return { value: out, indicators };
}

function redactWorkflowForResponse(doc) {
  if (Array.isArray(doc)) return doc.map((item) => redactWorkflowForResponse(item));
  const plain = toPlain(doc);
  return walk(plain, {
    parentKey: "",
    inConfig: false,
    triggerConfig: false,
    inHeaders: false,
    path: [],
  }).value;
}

function redactValue(value) {
  return walk(value, {
    parentKey: "",
    inConfig: false,
    triggerConfig: false,
    inHeaders: false,
    path: [],
  }).value;
}

function redactRunForResponse(run) {
  const plain = toPlain(run);
  if (!plain || typeof plain !== "object") return plain;
  const out = { ...plain };
  if ("context" in plain) out.context = redactValue(plain.context);
  if ("logs" in plain) out.logs = redactValue(plain.logs);
  if (plain.wait && typeof plain.wait === "object") {
    out.wait = { ...plain.wait };
    if ("completion" in plain.wait) {
      out.wait.completion = redactValue(plain.wait.completion);
    }
  }
  if ("external" in plain) out.external = redactValue(plain.external);
  if ("notifications" in plain) out.notifications = redactValue(plain.notifications);
  return out;
}

function clonePlain(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function getAt(obj, path) {
  const parts = String(path).split(".").filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

function setAt(obj, path, value) {
  const parts = String(path).split(".").filter(Boolean);
  if (parts.length === 0) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!cur[part] || typeof cur[part] !== "object") cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

function omittedSecret(value) {
  return value === undefined || value === null || value === "";
}

function stripSecretSet(value) {
  if (Array.isArray(value)) {
    value.forEach(stripSecretSet);
    return;
  }
  if (!value || typeof value !== "object") return;
  delete value.secretSet;
  for (const child of Object.values(value)) stripSecretSet(child);
}

/**
 * An omitted secret whose indicator is true keeps the stored value.
 * A new non-empty secret replaces it. `secretSet` is not stored.
 */
function prepareWorkflowWrite(incoming, stored) {
  const next = clonePlain(incoming);
  if (!next || typeof next !== "object") return next;
  const previous = stored ? toPlain(stored) : null;

  if (
    previous &&
    next.trigger &&
    next.trigger.config &&
    previous.trigger &&
    previous.trigger.config &&
    next.trigger.config.secretSet === true &&
    omittedSecret(next.trigger.config.secret) &&
    !omittedSecret(previous.trigger.config.secret)
  ) {
    next.trigger.config.secret = previous.trigger.config.secret;
  }

  if (previous && Array.isArray(next.nodes) && Array.isArray(previous.nodes)) {
    const byId = new Map(previous.nodes.filter((node) => node && node.id).map((node) => [node.id, node]));
    for (const node of next.nodes) {
      if (!node || !node.config || !node.id) continue;
      const prior = byId.get(node.id);
      const indicator = node.config.secretSet;
      if (!prior || !prior.config || !indicator || typeof indicator !== "object" || Array.isArray(indicator)) {
        continue;
      }
      for (const [path, flag] of Object.entries(indicator)) {
        if (flag !== true) continue;
        if (!omittedSecret(getAt(node.config, path))) continue;
        const kept = getAt(prior.config, path);
        if (!omittedSecret(kept)) setAt(node.config, path, kept);
      }
    }
  }

  stripSecretSet(next);
  return next;
}

module.exports = {
  redactWorkflowForResponse,
  redactRunForResponse,
  prepareWorkflowWrite,
};
