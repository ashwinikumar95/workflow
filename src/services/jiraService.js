const crypto = require("crypto");
const axios = require("axios");
const config = require("../../config");

const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const SUMMARY_TAG = /\[@[A-Z][A-Z0-9]*-\d+(?:-\d+)*\]/gi;
const SEARCH_FIELDS = [
  "summary",
  "description",
  "status",
  "issuetype",
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
    issueType,
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

/**
 * @param {string} issueKey
 * @param {{ http?: { get: Function }, sleep?: Function, attempts?: number }} [deps]
 */
async function getTransitions(issueKey, deps = {}) {
  assertIssueKey(issueKey);
  const http = httpClient(deps);
  const res = await withRetry(
    () =>
      http.get(`${jiraBase()}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, requestOptions()),
    deps
  );
  const data = res && res.data ? res.data : {};
  const list = Array.isArray(data.transitions) ? data.transitions : [];
  return list.map((item) => ({
    id: item && item.id != null ? String(item.id) : "",
    name: item && item.name != null ? String(item.name) : "",
    to: item && item.to && item.to.name != null ? String(item.to.name) : "",
  }));
}

function matchTransition(transitions, statusName) {
  const want = String(statusName || "").trim().toLowerCase();
  if (!want) return null;
  const list = Array.isArray(transitions) ? transitions : [];
  return (
    list.find((item) => item.to && item.to.toLowerCase() === want) ||
    list.find((item) => item.name && item.name.toLowerCase() === want) ||
    null
  );
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

/**
 * @param {string} issueKey
 * @param {string} statusName
 * @param {{ http?: object, sleep?: Function, attempts?: number, marker?: string, commentOnMissing?: boolean, currentStatus?: string }} [deps]
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
  if (issue.status && issue.status.toLowerCase() === target.toLowerCase()) {
    return { ok: true, reason: "already_in_status" };
  }

  const transitions = await getTransitions(issueKey, deps);
  const match = matchTransition(transitions, target);
  if (!match || !match.id) {
    const commentOnMissing = deps.commentOnMissing !== false;
    if (commentOnMissing) {
      const mark = typeof deps.marker === "string" ? deps.marker.trim() : "";
      const text = [
        `Could not transition ${issueKey} to "${target}": that transition is not offered.`,
        mark,
      ]
        .filter(Boolean)
        .join("\n");
      const comment = await addComment(issueKey, text, mark, deps);
      return { ok: false, reason: "not_offered", commented: Boolean(comment && comment.posted) };
    }
    return { ok: false, reason: "not_offered", commented: false };
  }

  const http = httpClient(deps);
  await withRetry(
    () =>
      http.post(
        `${jiraBase()}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
        { transition: { id: match.id } },
        requestOptions()
      ),
    deps
  );
  return { ok: true, reason: "transitioned", id: match.id };
}

module.exports = {
  ISSUE_KEY,
  SEARCH_FIELDS,
  MAX_SEARCH_PAGES,
  fetchIssue,
  searchIssues,
  searchIssuesDetailed,
  getTransitions,
  transitionIssue,
  addComment,
  adfToText,
  parseIssueRef,
  contentFingerprint,
  commentMarker,
  summaryTags,
  normalizeIssue,
  is429,
  retryAfterMs,
};
