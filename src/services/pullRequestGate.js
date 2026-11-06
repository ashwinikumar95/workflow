/**
 * Runtime gate. Throws before push or GitHub when the predecessor pass is missing.
 */
function gateSource(external, role) {
  if (external && external.repos && typeof external.repos === "object") {
    if (role && external.repos[role]) return external.repos[role];
    return null;
  }
  return external || null;
}

function assertPullRequestGate({ external, predecessorId, head, role }) {
  const source = gateSource(external, role);
  const map =
    (source && source.playwrightByNode) || (external && external.playwrightByNode);
  const entry = map && predecessorId ? map[predecessorId] : undefined;
  const tested = source && source.testedSha;
  if (!entry || entry.status !== "passed" || entry.reportPresent !== true) {
    throw new Error("Pull request gate rejected");
  }
  if (!tested || entry.testedSha !== tested || tested !== head) {
    throw new Error("Pull request gate rejected");
  }
}

module.exports = { assertPullRequestGate };
