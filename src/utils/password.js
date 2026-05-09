const crypto = require("crypto");
const { promisify } = require("util");

const scryptAsync = promisify(crypto.scrypt);
const KEY_LEN = 64;

/**
 * @param {string} password
 * @returns {Promise<string>}
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scryptAsync(password, salt, KEY_LEN);
  return `${salt}:${derived.toString("hex")}`;
}

/**
 * @param {string} password
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, stored) {
  const parts = stored.split(":");
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  const derived = await scryptAsync(password, salt, KEY_LEN);
  try {
    return crypto.timingSafeEqual(Buffer.from(keyHex, "hex"), derived);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
