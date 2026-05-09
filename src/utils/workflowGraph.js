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

  return { ok: true };
}

module.exports = { validateWorkflowGraph };
