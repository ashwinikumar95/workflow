/**
 * @param {string | undefined} headerValue
 * @returns {string | null}
 */
function parseBearerToken(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') {
    return null;
  }
  const trimmed = headerValue.trim();
  if (trimmed.toLowerCase().startsWith('bearer ')) {
    return trimmed.slice(7).trim() || null;
  }
  return trimmed || null;
}

module.exports = { parseBearerToken };
