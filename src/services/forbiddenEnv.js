function profileCredentialRefs() {
  try {
    const { parseProfiles } = require("./projectRegistry");
    return Object.values(parseProfiles()).map((profile) => profile.repo.credentialRef);
  } catch {
    return [];
  }
}

/** Names that must never appear in a git push child or a sandbox container. */
const FORBIDDEN_ENV = [
  ...new Set([
    "MONGODB_URI",
    "JWT_SECRET",
    "JIRA_API_TOKEN",
    "JIRA_EMAIL",
    "JIRA_WEBHOOK_SECRET",
    "ANALYSIS_API_KEY",
    "SLACK_WEBHOOK_URL",
    "GITHUB_TOKEN",
    "REDIS_PASSWORD",
    ...profileCredentialRefs(),
  ]),
];

function assertEnvAllowed(env) {
  if (!env || typeof env !== "object") return;
  for (const name of FORBIDDEN_ENV) {
    if (Object.prototype.hasOwnProperty.call(env, name)) {
      throw new Error(`Forbidden environment variable ${name}`);
    }
  }
}

function capUtf8(text, bytes) {
  const buf = Buffer.from(String(text == null ? "" : text), "utf8");
  if (buf.length <= bytes) return buf.toString("utf8");
  return buf.subarray(0, bytes).toString("utf8");
}

function redactOutput(text) {
  let out = String(text == null ? "" : text);
  for (const name of FORBIDDEN_ENV) {
    const value = process.env[name];
    if (typeof value === "string" && value.length > 0) {
      out = out.split(value).join("[redacted]");
    }
  }
  return capUtf8(out, 32 * 1024);
}

module.exports = {
  FORBIDDEN_ENV,
  assertEnvAllowed,
  capUtf8,
  redactOutput,
};
