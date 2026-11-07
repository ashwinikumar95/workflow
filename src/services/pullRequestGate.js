/**
 * Runtime gate. Throws before push or GitHub when the predecessor pass is missing.
 */
function assertPullRequestGate({ external, predecessorId, head }) {
  const map = external && external.playwrightByNode;
  const entry = map && predecessorId ? map[predecessorId] : undefined;
  const tested = external && external.testedSha;
  if (!entry || entry.status !== "passed" || entry.reportPresent !== true) {
    throw new Error("Pull request gate rejected");
  }
  if (!tested || entry.testedSha !== tested || tested !== head) {
    throw new Error("Pull request gate rejected");
  }
}

module.exports = { assertPullRequestGate };
