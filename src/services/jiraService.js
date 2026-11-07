const crypto = require("crypto");
const axios = require("axios");
const config = require("../../config");
const {
  MAX_HOPS,
  alreadyInStatus,
  resolveStatusName,
  matchTransition,
  findTransitionPath,
  parseWorkflowPayload,
  fillRequiredFields,
  missingFieldsFromError,
  formatOffered,
  formatHops,
} = require("./jiraTransition");

const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const SUMMARY_TAG = /\[@[A-Z][A-Z0-9]*-\d+(?:-\d+)*\]/gi;
const SEARCH_FIELDS = [
  "summary",
  "description",
  "status",
  "issuetype",
  "project",
  "labels",
  "components",
  "updated",
];
const MAX_RETRY_AFTER_MS = 60 * 1000;
const DEFAULT_RETRY_AFTER_MS = 1000;
const MAX_SEARCH_PAGES = 50;
const DEFAULT_SEARCH_PAGE_SIZE = 50;

function adfToText(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node !== "object") return "";
  if (node.type === "text" && typeof node.text === "string") return node.text;
  const children = Array.isArray(node.content) ? node.content.map(adfToText) : [];
  const block = node.type === "paragraph" || node.type === "heading" || node.type === "listItem";
  return children.join(block ? "\n" : "");
}

function sleep(ms) {
  const wait = Number(ms);
  if (!Number.isFinite(wait) || wait <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, wait);
  });
}

function is429(err) {
  return Boolean(err && err.response && err.response.status === 429);
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const want = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === want) {
      if (Array.isArray(value)) return String(value[0] || "");
      return value == null ? "" : String(value);
    }
  }
  return "";
}

function retryAfterMs(response) {
  const raw = headerValue(response && response.headers, "retry-after").trim();
  if (!raw) return DEFAULT_RETRY_AFTER_MS;
  if (/^[0-9]+$/.test(raw)) {
    return Math.min(Number(raw) * 1000, MAX_RETRY_AFTER_MS);
  }
  const when = Date.parse(raw);
  if (!Number.isFinite(when)) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(Math.max(0, when - Date.now()), MAX_RETRY_AFTER_MS);
}

async function withRetry(fn, deps = {}) {
  const sleepFn = deps.sleep || sleep;
  const attempts = Number.isInteger(deps.attempts) && deps.attempts > 0 ? deps.attempts : 5;
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!is429(err) || i === attempts - 1) throw err;
      await sleepFn(retryAfterMs(err.response));
    }
  }
  throw last;
}

function jiraBase() {
  const base = String(config.jiraBaseUrl || "").replace(/\/$/, "");
  if (!base) {
    const err = new Error("JIRA_BASE_URL is not set");
    err.statusCode = 500;
    throw err;
  }
  return base;
}

function authHeaders() {
  const email = config.jiraEmail;
  const token = config.jiraApiToken;
  const encoded = Buffer.from(`${email}:${token}`).toString("base64");
  return {
    Authorization: `Basic ${encoded}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function requestOptions() {
  return {
    timeout: config.httpTimeoutMs,
    maxRedirects: 0,
    headers: authHeaders(),
  };
}

function httpClient(deps = {}) {
  return deps.http || axios;
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && item.name != null) return String(item.name);
      return "";
    })
    .filter(Boolean);
}

function summaryTags(summary) {
  const matches = String(summary || "").match(SUMMARY_TAG);
  if (!matches) return [];
  return [...new Set(matches.map((tag) => tag.toUpperCase()))];
}

function contentFingerprint(issue) {
  const summary = issue && issue.summary != null ? String(issue.summary) : "";
  const description = issue && issue.descriptionText != null ? String(issue.descriptionText) : "";
  const acceptance = issue && issue.acceptanceCriteria != null ? String(issue.acceptanceCriteria) : "";
  return crypto.createHash("sha256").update(`${summary}\n${description}\n${acceptance}`, "utf8").digest("hex");
}

function normalizeIssue(data, fallbackKey) {
  const fields = data && data.fields ? data.fields : {};
  const status = fields.status && fields.status.name ? String(fields.status.name) : "";
  const issueType = fields.issuetype && fields.issuetype.name ? String(fields.issuetype.name) : "";
  const summary = fields.summary != null ? String(fields.summary) : "";
  const descriptionText = adfToText(fields.description).trim();
  const acceptanceCriteria = adfToText(fields.acceptanceCriteria).trim();
  const issue = {
    id: data && data.id != null ? String(data.id) : "",
    key: data && data.key != null ? String(data.key) : fallbackKey || "",
    summary,
    descriptionText,
    status,
    statusId: fields.status && fields.status.id != null ? String(fields.status.id) : "",
    issueType,
    issueTypeId: fields.issuetype && fields.issuetype.id != null ? String(fields.issuetype.id) : "",
    projectId: fields.project && fields.project.id != null ? String(fields.project.id) : "",
    projectKey: fields.project && fields.project.key != null ? String(fields.project.key) : "",
    labels: asStringArray(fields.labels),
    components: asStringArray(fields.components),
    acceptanceCriteria,
    updated: fields.updated != null ? String(fields.updated) : "",
    tags: summaryTags(summary),
  };
  issue.fingerprint = contentFingerprint(issue);
  return issue;
}

function parseIssueRef(input) {
  const text = String(input || "").trim();
  if (!text) return "";
  const browse = text.match(/\/browse\/([A-Za-z][A-Za-z0-9]+-\d+)/);
  if (browse) return browse[1].toUpperCase();
  const issuesPath = text.match(/\/issues\/([A-Za-z][A-Za-z0-9]+-\d+)/);
  if (issuesPath) return issuesPath[1].toUpperCase();
  if (ISSUE_KEY.test(text.toUpperCase())) return text.toUpperCase();
  return "";
}

function commentMarker(runId, nodeId) {
  const run = runId != null ? String(runId) : "";
  const node = nodeId != null ? String(nodeId) : "";
  if (!run || !node) return "";
  return `[wf:${run}:${node}]`;
}

function assertIssueKey(issueKey) {
  if (typeof issueKey !== "string" || !ISSUE_KEY.test(issueKey)) {
    const err = new Error("Invalid issue key");
    err.statusCode = 400;
    throw err;
  }
}

/**
 * @param {string} issueKey
 * @param {{ http?: { get: Function }, sleep?: Function, attempts?: number }} [deps]
 */
async function fetchIssue(issueKey, deps = {}) {
  assertIssueKey(issueKey);
  const http = httpClient(deps);
  const res = await withRetry(
    () =>
      http.get(`${jiraBase()}/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
        ...requestOptions(),
        params: { fields: SEARCH_FIELDS.join(",") },
      }),
    deps
  );
  return normalizeIssue(res && res.data ? res.data : {}, issueKey);
}

function searchLimit(deps = {}) {
  const maxResults =
    Number.isInteger(deps.maxResults) && deps.maxResults > 0
      ? deps.maxResults
      : DEFAULT_SEARCH_PAGE_SIZE;
  const maxIssues =
    Number.isInteger(deps.maxIssues) && deps.maxIssues > 0 ? deps.maxIssues : Number.POSITIVE_INFINITY;
  const pageDelayMs =
    Number.isInteger(deps.pageDelayMs) && deps.pageDelayMs >= 0 ? deps.pageDelayMs : 0;
  const maxPages =
    Number.isInteger(deps.maxPages) && deps.maxPages > 0 ? deps.maxPages : MAX_SEARCH_PAGES;
  return { maxResults, maxIssues, pageDelayMs, maxPages };
}

/**
 * @param {string} jql
 * @param {{ http?: { post: Function }, sleep?: Function, attempts?: number, maxResults?: number, maxIssues?: number, pageDelayMs?: number, maxPages?: number }} [deps]
 */
async function searchIssuesDetailed(jql, deps = {}) {
  const query = typeof jql === "string" ? jql.trim() : "";
  if (!query) return { issues: [], truncated: false, reason: "", pages: 0 };
  const http = httpClient(deps);
  const sleepFn = deps.sleep || sleep;
  const { maxResults, maxIssues, pageDelayMs, maxPages } = searchLimit(deps);
  const issues = [];
  let nextPageToken = "";
  let pages = 0;
  let truncated = false;
  let reason = "";

  for (let page = 0; page < maxPages; page += 1) {
    const remaining = maxIssues - issues.length;
    if (!(remaining > 0)) {
      truncated = true;
      reason = "max_issues";
      break;
    }
    const body = {
      jql: query,
      maxResults: Math.min(maxResults, remaining),
      fields: SEARCH_FIELDS,
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    let res;
    try {
      res = await withRetry(
        () => http.post(`${jiraBase()}/rest/api/3/search/jql`, body, requestOptions()),
        deps
      );
    } catch (err) {
      if (is429(err) && issues.length) {
        return { issues, truncated: true, reason: "rate_limited", pages };
      }
      throw err;
    }
    pages += 1;
    const data = res && res.data ? res.data : {};
    const batch = Array.isArray(data.issues) ? data.issues : [];
    for (const raw of batch) {
      if (issues.length >= maxIssues) {
        truncated = true;
        reason = "max_issues";
        break;
      }
      issues.push(normalizeIssue(raw, raw && raw.key));
    }
    if (truncated) break;
    if (data.isLast || !data.nextPageToken) break;
    if (issues.length >= maxIssues) {
      truncated = true;
      reason = "max_issues";
      break;
    }
    nextPageToken = String(data.nextPageToken);
    if (pageDelayMs > 0) await sleepFn(pageDelayMs);
  }
  return { issues, truncated, reason, pages };
}

/**
 * @param {string} jql
 * @param {{ http?: { post: Function }, sleep?: Function, attempts?: number, maxResults?: number, maxIssues?: number, pageDelayMs?: number }} [deps]
 */
async function searchIssues(jql, deps = {}) {
  const result = await searchIssuesDetailed(jql, deps);
  const issues = result.issues;
  issues.truncated = result.truncated;
  issues.reason = result.reason;
  issues.pages = result.pages;
  return issues;
}

function mapTransition(item) {
  return {
    id: item && item.id != null ? String(item.id) : "",
    name: item && item.name != null ? String(item.name) : "",
    to: item && item.to && item.to.name != null ? String(item.to.name) : "",
    toId: item && item.to && item.to.id != null ? String(item.to.id) : "",
    fields: item && item.fields && typeof item.fields === "object" ? item.fields : {},
  };
}

/**
 * @param {string} issueKey
 * @param {{ http?: { get: Function }, sleep?: Function, attempts?: number }} [deps]
 */
async function getTransitions(issueKey, deps = {}) {
  assertIssueKey(issueKey);
  const http = httpClient(deps);
  const res = await withRetry(
    () =>
      http.get(`${jiraBase()}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
        ...requestOptions(),
        params: { expand: "transitions.fields" },
      }),
    deps
  );
  const data = res && res.data ? res.data : {};
  const list = Array.isArray(data.transitions) ? data.transitions : [];
  return list.map(mapTransition);
}

async function listCommentTexts(issueKey, deps = {}) {
  const http = httpClient(deps);
  const res = await withRetry(
    () =>
      http.get(`${jiraBase()}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
        ...requestOptions(),
        params: { maxResults: 100 },
      }),
    deps
  );
  const data = res && res.data ? res.data : {};
  const comments = Array.isArray(data.comments) ? data.comments : [];
  return comments.map((comment) => adfToText(comment && comment.body).trim());
}

function commentBody(text) {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: String(text || "") }],
      },
    ],
  };
}

/**
 * @param {string} issueKey
 * @param {string} text
 * @param {string} [marker]
 * @param {{ http?: { get: Function, post: Function }, sleep?: Function, attempts?: number }} [deps]
 */
async function addComment(issueKey, text, marker, deps = {}) {
  assertIssueKey(issueKey);
  const mark = typeof marker === "string" ? marker.trim() : "";
  if (mark) {
    const existing = await listCommentTexts(issueKey, deps);
    if (existing.some((body) => body.includes(mark))) {
      return { ok: true, posted: false, reason: "duplicate_marker" };
    }
  }
  const http = httpClient(deps);
  await withRetry(
    () =>
      http.post(
        `${jiraBase()}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
        { body: commentBody(text) },
        requestOptions()
      ),
    deps
  );
  return { ok: true, posted: true };
}

const workflowCache = new Map();
let myselfCache = null;

function clearWorkflowCache() {
  workflowCache.clear();
  myselfCache = null;
}

function isHttpStatus(err, status) {
  return Boolean(err && err.response && err.response.status === status);
}

async function getMyself(deps = {}) {
  if (myselfCache && !deps.skipCache) return myselfCache;
  const http = httpClient(deps);
  try {
    const res = await withRetry(() => http.get(`${jiraBase()}/rest/api/3/myself`, requestOptions()), deps);
    const data = res && res.data ? res.data : {};
    myselfCache = {
      accountId: data.accountId != null ? String(data.accountId) : "",
      emailAddress: data.emailAddress != null ? String(data.emailAddress) : "",
    };
    return myselfCache;
  } catch {
    return { accountId: "", emailAddress: "" };
  }
}

async function getEditMeta(issueKey, deps = {}) {
  assertIssueKey(issueKey);
  const http = httpClient(deps);
  try {
    const res = await withRetry(
      () =>
        http.get(`${jiraBase()}/rest/api/3/issue/${encodeURIComponent(issueKey)}/editmeta`, requestOptions()),
      deps
    );
    const data = res && res.data ? res.data : {};
    return data.fields && typeof data.fields === "object" ? data.fields : {};
  } catch (err) {
    if (isHttpStatus(err, 404) || isHttpStatus(err, 400)) return {};
    throw err;
  }
}

/**
 * @param {string} issueKey
 * @param {object} fields
 * @param {{ http?: { put: Function }, sleep?: Function, attempts?: number }} [deps]
 */
async function updateIssueFields(issueKey, fields, deps = {}) {
  assertIssueKey(issueKey);
  if (!fields || typeof fields !== "object" || !Object.keys(fields).length) {
    return { ok: true, updated: false };
  }
  const http = httpClient(deps);
  await withRetry(
    () =>
      http.put(
        `${jiraBase()}/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
        { fields },
        requestOptions()
      ),
    deps
  );
  return { ok: true, updated: true };
}

async function getIssueWorkflow(issueKey, deps = {}) {
  assertIssueKey(issueKey);
  const issue = deps.issue && typeof deps.issue === "object" ? deps.issue : await fetchIssue(issueKey, deps);
  const cacheKey = issue.projectId && issue.issueTypeId ? `${issue.projectId}::${issue.issueTypeId}` : "";
  if (cacheKey && !deps.skipCache && workflowCache.has(cacheKey)) {
    return workflowCache.get(cacheKey);
  }

  const http = httpClient(deps);
  let graph = { statuses: [], transitions: [] };

  try {
    const res = await withRetry(
      () =>
        http.post(
          `${jiraBase()}/rest/api/3/workflows`,
          {
            projectAndIssueTypes: [
              {
                projectId: issue.projectId || undefined,
                issueTypeId: issue.issueTypeId || undefined,
              },
            ],
          },
          requestOptions()
        ),
      deps
    );
    graph = parseWorkflowPayload(res && res.data ? res.data : {});
  } catch (err) {
    if (err && !err.response) {
      graph = { statuses: [], transitions: [] };
    } else {
      try {
        const res = await withRetry(
          () =>
            http.get(`${jiraBase()}/rest/api/3/workflow/search`, {
              ...requestOptions(),
              params: { expand: "transitions,statuses", maxResults: 100 },
            }),
          deps
        );
        graph = parseWorkflowPayload(res && res.data ? res.data : {});
      } catch {
        graph = { statuses: [], transitions: [] };
      }
    }
  }

  if (cacheKey) workflowCache.set(cacheKey, graph);
  return graph;
}

function transitionPayload(match, fields, needsComment, deps) {
  const payload = { transition: { id: match.id } };
  if (fields && Object.keys(fields).length) payload.fields = fields;
  if (needsComment) {
    const text = [deps.commentText || deps.reason || `Transition to ${match.to}`, deps.marker]
      .filter(Boolean)
      .join("\n");
    payload.update = { comment: [{ add: { body: commentBody(text) } }] };
  }
  return payload;
}

async function postTransition(issueKey, match, filled, deps) {
  const http = httpClient(deps);
  let fields = { ...(filled.fields || {}) };
  let needsComment = Boolean(filled.needsComment);
  const post = (body) =>
    withRetry(
      () =>
        http.post(
          `${jiraBase()}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
          body,
          requestOptions()
        ),
      deps
    );

  try {
    await post(transitionPayload(match, fields, needsComment, deps));
    return { ok: true, fields };
  } catch (err) {
    if (!isHttpStatus(err, 400)) throw err;
    const names = missingFieldsFromError(err);
    if (!names.length) throw err;
    const schema = {};
    for (const name of names) {
      schema[name] =
        match.fields && match.fields[name]
          ? match.fields[name]
          : { required: true, schema: { type: "string" } };
    }
    const extra = fillRequiredFields(schema, deps);
    fields = { ...fields, ...extra.fields };
    needsComment = needsComment || extra.needsComment || names.includes("comment");
    const stillMissing = extra.missing.filter((name) => fields[name] == null && name !== "comment");
    if (stillMissing.length) {
      return { ok: false, missing: stillMissing, fields };
    }
    await post(transitionPayload(match, fields, needsComment, deps));
    return { ok: true, retried: true, fields };
  }
}

async function maybeUnlockHop(issueKey, deps) {
  const overlay =
    deps.transitionFields && typeof deps.transitionFields === "object" ? deps.transitionFields : {};
  let editmeta = {};
  try {
    editmeta = await getEditMeta(issueKey, deps);
  } catch {
    editmeta = {};
  }
  const toPut = {};
  for (const [key, value] of Object.entries(overlay)) {
    toPut[key] = value;
  }
  const filled = fillRequiredFields(editmeta, { ...deps, transitionFields: overlay });
  for (const [key, value] of Object.entries(filled.fields || {})) {
    if (toPut[key] == null) toPut[key] = value;
  }
  if (!Object.keys(toPut).length) return { updated: false, missing: filled.missing };
  await updateIssueFields(issueKey, toPut, deps);
  return { updated: true, missing: filled.missing, fields: toPut };
}

async function commentFailure(issueKey, lines, deps, extra = {}) {
  const commentOnMissing = deps.commentOnMissing !== false;
  if (!commentOnMissing) {
    return { ok: false, commented: false, ...extra };
  }
  const mark = typeof deps.marker === "string" ? deps.marker.trim() : "";
  const text = [...lines, mark].filter(Boolean).join("\n");
  const comment = await addComment(issueKey, text, mark, deps);
  return { ok: false, commented: Boolean(comment && comment.posted), ...extra };
}

async function resolveHop(issueKey, dest, statuses, deps) {
  let offered = await getTransitions(issueKey, deps);
  let match = matchTransition(offered, dest, statuses);
  if (match && match.id) return { match, offered };
  const unlocked = await maybeUnlockHop(issueKey, deps);
  if (unlocked.updated) {
    offered = await getTransitions(issueKey, deps);
    match = matchTransition(offered, dest, statuses);
    if (match && match.id) return { match, offered, unlocked: true };
  }
  return { match: null, offered };
}

/**
 * @param {string} issueKey
 * @param {string} statusName
 * @param {{ http?: object, sleep?: Function, attempts?: number, marker?: string, commentOnMissing?: boolean, commentText?: string, reason?: string, transitionFields?: object, preferredStatuses?: string[] }} [deps]
 */
async function transitionIssue(issueKey, statusName, deps = {}) {
  assertIssueKey(issueKey);
  const target = String(statusName || "").trim();
  if (!target) {
    const err = new Error("Status name is required");
    err.statusCode = 400;
    throw err;
  }

  const issue = await fetchIssue(issueKey, deps);
  let workflow = { statuses: [], transitions: [] };
  try {
    workflow = await getIssueWorkflow(issueKey, { ...deps, issue });
  } catch {
    workflow = { statuses: [], transitions: [] };
  }
  const statuses = workflow.statuses || [];
  const resolvedTarget = resolveStatusName(target, statuses) || target;

  if (alreadyInStatus(issue.status, resolvedTarget, statuses) || alreadyInStatus(issue.status, target, statuses)) {
    return { ok: true, reason: "already_in_status", hops: [] };
  }

  const myself = await getMyself(deps);
  const fillDeps = { ...deps, myself };
  const preferred = Array.isArray(deps.preferredStatuses) ? deps.preferredStatuses : [];
  const hops = [];
  const seen = new Set();
  let current = issue.status;
  seen.add(String(current || "").toLowerCase());

  let path = [];
  const offeredStart = await getTransitions(issueKey, deps);
  const direct = matchTransition(offeredStart, resolvedTarget, statuses);
  if (direct && direct.id) {
    path = [{ id: direct.id, name: direct.name, to: direct.to || resolvedTarget, from: current }];
  } else if (workflow.transitions && workflow.transitions.length) {
    path = findTransitionPath(workflow, current, resolvedTarget, { preferredStatuses: preferred });
  }

  if (!path.length) {
    return commentFailure(
      issueKey,
      [
        `Could not transition ${issueKey} to "${target}": that transition is not offered.`,
        offeredStart.length ? `Offered: ${formatOffered(offeredStart)}` : "",
      ],
      deps,
      { reason: "not_offered", hops, offered: offeredStart }
    );
  }
  if (path.length > MAX_HOPS) {
    return commentFailure(
      issueKey,
      [
        `Could not transition ${issueKey} to "${target}": path is longer than ${MAX_HOPS} hops.`,
        `Offered: ${formatOffered(offeredStart)}`,
      ],
      deps,
      { reason: "not_offered", hops, offered: offeredStart }
    );
  }

  for (const step of path) {
    const dest = step.to || resolvedTarget;
    if (alreadyInStatus(current, dest, statuses)) continue;
    const { match, offered } = await resolveHop(issueKey, dest, statuses, fillDeps);
    if (!match || !match.id) {
      return commentFailure(
        issueKey,
        [
          `Could not transition ${issueKey} to "${target}": that transition is not offered.`,
          offered.length ? `Offered: ${formatOffered(offered)}` : "",
          hops.length ? `Attempted: ${current}${hops.length ? ` → ${formatHops(hops)}` : ""}` : "",
        ],
        deps,
        { reason: "not_offered", hops, offered }
      );
    }

    const filled = fillRequiredFields(match.fields, fillDeps);
    if (filled.missing.length) {
      return commentFailure(
        issueKey,
        [
          `Could not transition ${issueKey} to "${match.to || dest}": missing required fields ${filled.missing.join(", ")}.`,
          hops.length ? `Attempted: ${formatHops(hops)}` : "",
        ],
        deps,
        { reason: "missing_fields", hops, missing: filled.missing }
      );
    }

    const posted = await postTransition(issueKey, match, filled, fillDeps);
    if (!posted.ok) {
      return commentFailure(
        issueKey,
        [
          `Could not transition ${issueKey} to "${match.to || dest}": missing required fields ${(posted.missing || []).join(", ")}.`,
          hops.length ? `Attempted: ${formatHops(hops)}` : "",
        ],
        deps,
        { reason: "missing_fields", hops, missing: posted.missing }
      );
    }

    hops.push({ id: match.id, name: match.name, to: match.to || dest });
    current = match.to || dest;
    const key = String(current || "").toLowerCase();
    if (seen.has(key)) break;
    seen.add(key);
  }

  if (!alreadyInStatus(current, resolvedTarget, statuses) && !alreadyInStatus(current, target, statuses)) {
    return commentFailure(
      issueKey,
      [
        `Could not transition ${issueKey} to "${target}": that transition is not offered.`,
        hops.length ? `Attempted: ${formatHops(hops)}` : "",
      ],
      deps,
      { reason: "not_offered", hops }
    );
  }

  const last = hops[hops.length - 1];
  return {
    ok: true,
    reason: "transitioned",
    id: last ? last.id : undefined,
    hops,
  };
}

module.exports = {
  ISSUE_KEY,
  SEARCH_FIELDS,
  MAX_SEARCH_PAGES,
  fetchIssue,
  searchIssues,
  searchIssuesDetailed,
  getTransitions,
  getIssueWorkflow,
  getEditMeta,
  updateIssueFields,
  transitionIssue,
  addComment,
  clearWorkflowCache,
  adfToText,
  parseIssueRef,
  contentFingerprint,
  commentMarker,
  summaryTags,
  normalizeIssue,
  is429,
  retryAfterMs,
};
