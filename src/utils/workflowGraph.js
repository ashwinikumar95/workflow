/**
 * @param {{ nodes?: { id?: string }[]; edges?: { from: string; to: string }[] }} workflow
 * @returns {{ ok: true } | { ok: false; message: string }}
 */
function validateWorkflowGraph(workflow) {
  const nodes = workflow.nodes || [];
  const edges = workflow.edges || [];

  if (nodes.length === 0) {
    return { ok: false, message: "Workflow must have at least one node" };
  }

  const ids = new Set(nodes.map((n) => n.id).filter(Boolean));
  if (ids.size !== nodes.length) {
    return { ok: false, message: "Each node must have a unique id" };
  }

  for (const node of nodes) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(node.id)) {
      return {
        ok: false,
        message: "Node id must match ^[A-Za-z0-9_-]{1,64}$",
      };
    }
  }

  for (const e of edges) {
    if (!e.from || !e.to) {
      return { ok: false, message: "Each edge must have from and to" };
    }
    if (!ids.has(e.from) || !ids.has(e.to)) {
      return { ok: false, message: "Edge references unknown node id" };
    }
  }

  const incoming = new Set(edges.map((e) => e.to));
  const starts = nodes.filter((n) => n.id && !incoming.has(n.id));
  if (starts.length !== 1) {
    return {
      ok: false,
      message:
        "Workflow must have exactly one start node (one node with no incoming edge)",
    };
  }

  const cycle = findCycle(nodes, edges);
  if (cycle) {
    return { ok: false, message: "Workflow graph contains a cycle" };
  }

  const split = validateBranchSplits(nodes, edges);
  if (split) return split;
  const tokens = validateConfigTokens(nodes);
  if (tokens) return tokens;
  const playwright = validatePlaywrightNodes(workflow, nodes);
  if (playwright) return playwright;
  const pullRequest = validatePullRequestPaths(nodes, edges);
  if (pullRequest) return pullRequest;

  return { ok: true };
}

function looksLikeToken(value) {
  return (
    value.includes("Bearer ") ||
    value.includes("ghp_") ||
    value.includes("ATATT") ||
    value.includes("cursor_")
  );
}

function walkConfigValues(value, inHeaders) {
  if (typeof value === "string") {
    if (!inHeaders && looksLikeToken(value)) return false;
    return true;
  }
  if (Array.isArray(value)) return value.every((item) => walkConfigValues(item, inHeaders));
  if (!value || typeof value !== "object") return true;
  for (const [key, child] of Object.entries(value)) {
    if (key === "__ui" || key === "secretSet") continue;
    const nextHeaders = inHeaders || String(key).toLowerCase() === "headers";
    if (!walkConfigValues(child, nextHeaders)) return false;
  }
  return true;
}

function validateConfigTokens(nodes) {
  for (const node of nodes) {
    if (!node || !node.config) continue;
    if (!walkConfigValues(node.config, false)) {
      return {
        ok: false,
        message: "Node config must not contain a token. Store secrets in the worker environment.",
      };
    }
  }
  return null;
}

function validateBranchSplits(nodes, edges) {
  for (const node of nodes) {
    if (!node || (node.type !== "condition" && node.type !== "approval")) continue;
    const outgoing = edges.filter((edge) => edge.from === node.id);
    if (outgoing.length <= 1) continue;
    const trues = outgoing.filter((edge) => edge.condition === "true");
    const falses = outgoing.filter((edge) => edge.condition === "false");
    if (outgoing.length !== 2 || trues.length !== 1 || falses.length !== 1) {
      return {
        ok: false,
        message: "Condition and approval splits need one true edge and one false edge",
      };
    }
  }
  return null;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0);
}

function validatePlaywrightNodes(workflow, nodes) {
  const needsRepo = nodes.some((node) =>
    node && ["gitBranch", "cursorAgent", "playwright", "githubPr"].includes(node.type)
  );
  if (needsRepo) {
    const repo = workflow.repository || {};
    if (!nonEmpty(repo.location) || !nonEmpty(repo.defaultBranch) || !nonEmpty(repo.credentialRef)) {
      return {
        ok: false,
        message: "Workflow requires a functional repository location, default branch, and credential reference",
      };
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(repo.credentialRef)) {
      return { ok: false, message: "Credential reference must be an environment variable name" };
    }
  }

  for (const node of nodes) {
    if (!node || node.type !== "playwright") continue;
    const cfg = node.config && typeof node.config === "object" ? node.config : {};
    if (cfg.strategy !== "in-repo" && cfg.strategy !== "external-repo") {
      return { ok: false, message: "Playwright node requires config.strategy" };
    }
    if (cfg.target !== "local-worktree" && cfg.target !== "deployed-preview") {
      return { ok: false, message: "Playwright node requires config.target" };
    }
    if (cfg.strategy === "in-repo" && !nonEmpty(cfg.testPath)) {
      return { ok: false, message: "In-repo Playwright requires a test path" };
    }
    if (cfg.strategy === "external-repo") {
      const testRepo = cfg.testRepository || {};
      if (!nonEmpty(testRepo.location) || !nonEmpty(testRepo.defaultBranch) || !stringArray(cfg.testCommand)) {
        return {
          ok: false,
          message: "External Playwright requires a repository location, default branch, and test command",
        };
      }
    }
    if (cfg.target === "local-worktree") {
      if (!stringArray(cfg.appCommand) || !nonEmpty(typeof cfg.readiness === "string" ? cfg.readiness : "")) {
        return { ok: false, message: "Local Playwright requires an app command and a readiness check" };
      }
    }
  }
  return null;
}

function validatePullRequestPaths(nodes, edges) {
  const githubNodes = nodes.filter((node) => node && node.type === "githubPr" && node.id);
  if (githubNodes.length === 0) return null;

  for (const node of githubNodes) {
    const incoming = edges.filter((edge) => edge.to === node.id);
    for (const edge of incoming) {
      const source = nodes.find((item) => item.id === edge.from);
      if (!source || source.type !== "playwright" || edge.condition !== "true") {
        return {
          ok: false,
          message: "githubPr is reachable without a Playwright true edge",
        };
      }
    }
  }

  const stripped = edges.filter((edge) => {
    const source = nodes.find((item) => item.id === edge.from);
    return !(source && source.type === "playwright" && edge.condition === "true");
  });
  const targets = new Set(githubNodes.map((node) => node.id));
  const incoming = new Set(edges.map((edge) => edge.to));
  const startIds = nodes.filter((node) => node.id && !incoming.has(node.id)).map((node) => node.id);
  if (reachableFromStart(nodes, stripped, targets, startIds)) {
    return { ok: false, message: "githubPr is reachable without a Playwright true edge" };
  }
  return null;
}

function reachableFromStart(nodes, edges, targetIds, startIds) {
  const adjacent = new Map();
  for (const node of nodes) {
    if (node.id) adjacent.set(node.id, []);
  }
  for (const edge of edges) {
    const list = adjacent.get(edge.from);
    if (list) list.push(edge.to);
  }
  const seen = new Set();
  const stack = [...startIds];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (targetIds.has(id)) return true;
    for (const next of adjacent.get(id) || []) stack.push(next);
  }
  return false;
}

/**
 * Depth-first search over every component, including nodes the start node cannot reach.
 * @param {{ id?: string }[]} nodes
 * @param {{ from: string; to: string }[]} edges
 */
function findCycle(nodes, edges) {
  const adjacent = new Map();
  for (const node of nodes) {
    if (node.id) adjacent.set(node.id, []);
  }
  for (const edge of edges) {
    const list = adjacent.get(edge.from);
    if (list) list.push(edge.to);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  for (const node of nodes) {
    if (node.id) color.set(node.id, WHITE);
  }

  function walk(id) {
    color.set(id, GRAY);
    for (const next of adjacent.get(id) || []) {
      const seen = color.get(next);
      if (seen === GRAY) return true;
      if (seen === WHITE && walk(next)) return true;
    }
    color.set(id, BLACK);
    return false;
  }

  for (const node of nodes) {
    if (node.id && color.get(node.id) === WHITE && walk(node.id)) return true;
  }
  return false;
}

module.exports = { validateWorkflowGraph };
