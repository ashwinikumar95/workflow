const axios = require("axios");
const config = require("../../config");

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getAtPath(obj, path) {
  if (path == null || typeof path !== "string") return undefined;
  const parts = path.split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

function interpolateMessage(template, input) {
  if (typeof template !== "string") return "";
  return template.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const v = getAtPath(input, key.trim());
    if (v === undefined || v === null) return "";
    if (typeof v === "object") return JSON.stringify(v).slice(0, 200);
    return String(v);
  });
}

function evaluateCondition(input, cfg) {
  const field = typeof cfg.field === "string" ? cfg.field : "";
  const op = typeof cfg.operator === "string" ? cfg.operator : "truthy";
  const val = field ? getAtPath(input, field) : input;

  switch (op) {
    case "exists":
      return field ? getAtPath(input, field) !== undefined : input != null;
    case "equals":
      return val === cfg.value;
    case "truthy":
    default:
      return Boolean(field ? getAtPath(input, field) : input);
  }
}

async function executeNode(node, input) {
  const cfg = node.config && typeof node.config === "object" ? node.config : {};

  switch (node.type) {
    case "http": {
      const headers =
        cfg.headers &&
        typeof cfg.headers === "object" &&
        !Array.isArray(cfg.headers)
          ? cfg.headers
          : {};
      const res = await axios({
        method: cfg.method || "GET",
        url: cfg.url,
        headers,
        data: cfg.body !== undefined ? cfg.body : {},
      });
      return res.data;
    }

    case "condition":
      return evaluateCondition(input, cfg);

    case "delay": {
      let sec = Number(cfg.seconds);
      if (!Number.isFinite(sec) || sec < 0) sec = 0;
      if (sec > 60) sec = 60;
      await sleep(Math.round(sec * 1000));
      return input;
    }

    case "notify": {
      const url = config.slackWebhookUrl;
      if (!url) {
        return {
          ...(input && typeof input === "object" && !Array.isArray(input)
            ? input
            : { payload: input }),
          _notifySkipped: true,
        };
      }
      const raw =
        typeof cfg.message === "string" ? cfg.message : "Workflow notification";
      const text = interpolateMessage(raw, input);
      await axios.post(url, { text }, { timeout: 15000 });
      return input && typeof input === "object" && !Array.isArray(input)
        ? input
        : { payload: input };
    }

    default:
      throw new Error(`Unknown node type: ${node.type}`);
  }
}

module.exports = { executeNode, getAtPath, evaluateCondition };
