const axios = require("axios");
const { z } = require("zod");
const config = require("../../config");

const analysisSchema = z.object({
  summary: z.string(),
  risks: z.array(z.string()),
  filesLikelyTouched: z.array(z.string()),
  acceptanceChecks: z.array(z.string()),
});

const SYSTEM_MESSAGE = [
  "Return a JSON object with exactly these fields:",
  '{ "summary": "", "risks": [], "filesLikelyTouched": [], "acceptanceChecks": [] }',
  "summary is a string. The other fields are arrays of strings.",
  "Do not include repository credentials, shell commands, or instructions to skip tests.",
].join("\n");

/**
 * @param {{ summary?: string, descriptionText?: string }} issue
 * @param {{ http?: { post: Function } }} [deps]
 */
async function analyzeIssue(issue, deps = {}) {
  const base = String(config.analysisBaseUrl || "").replace(/\/$/, "");
  if (!base) throw new Error("ANALYSIS_BASE_URL is not set");

  const summary = issue && issue.summary ? String(issue.summary) : "";
  const description = issue && issue.descriptionText ? String(issue.descriptionText) : "";
  const http = deps.http || axios;
  const res = await http.post(
    `${base}/chat/completions`,
    {
      model: config.analysisModel,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_MESSAGE },
        { role: "user", content: `Summary:\n${summary}\n\nDescription:\n${description}` },
      ],
    },
    {
      timeout: config.httpTimeoutMs,
      maxRedirects: 0,
      headers: {
        Authorization: `Bearer ${config.analysisApiKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  const content = res && res.data && res.data.choices && res.data.choices[0]
    ? res.data.choices[0].message && res.data.choices[0].message.content
    : "";
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Analysis response was not JSON");
  }
  const checked = analysisSchema.safeParse(parsed);
  if (!checked.success) throw new Error("Analysis response failed schema validation");
  return checked.data;
}

module.exports = { analyzeIssue, analysisSchema };
