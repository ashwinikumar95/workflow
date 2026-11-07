const axios = require("axios");
const config = require("../../config");

const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

function adfToText(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node !== "object") return "";
  if (node.type === "text" && typeof node.text === "string") return node.text;
  const children = Array.isArray(node.content) ? node.content.map(adfToText) : [];
  const block = node.type === "paragraph" || node.type === "heading" || node.type === "listItem";
  return children.join(block ? "\n" : "");
}

/**
 * @param {string} issueKey
 * @param {{ http?: { get: Function } }} [deps]
 */
async function fetchIssue(issueKey, deps = {}) {
  if (typeof issueKey !== "string" || !ISSUE_KEY.test(issueKey)) {
    const err = new Error("Invalid issue key");
    err.statusCode = 400;
    throw err;
  }

  const base = String(config.jiraBaseUrl || "").replace(/\/$/, "");
  if (!base) {
    const err = new Error("JIRA_BASE_URL is not set");
    err.statusCode = 500;
    throw err;
  }

  const http = deps.http || axios;
  const email = config.jiraEmail;
  const token = config.jiraApiToken;
  const encoded = Buffer.from(`${email}:${token}`).toString("base64");
  const res = await http.get(
    `${base}/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
    {
      params: { fields: "summary,description,status,issuetype" },
      headers: { Authorization: `Basic ${encoded}`, Accept: "application/json" },
      timeout: config.httpTimeoutMs,
      maxRedirects: 0,
    }
  );

  const data = res && res.data ? res.data : {};
  const fields = data.fields || {};
  const status = fields.status && fields.status.name ? String(fields.status.name) : "";
  return {
    id: data.id != null ? String(data.id) : "",
    key: data.key != null ? String(data.key) : issueKey,
    summary: fields.summary != null ? String(fields.summary) : "",
    descriptionText: adfToText(fields.description).trim(),
    status,
  };
}

module.exports = { fetchIssue, adfToText, ISSUE_KEY };
