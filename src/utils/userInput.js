const MIN_PASSWORD_LENGTH = 8;

function normalizeEmail(email) {
  if (email == null || typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

function normalizeName(name) {
  if (name == null || typeof name !== 'string') return '';
  return name.trim();
}

function validatePassword(password) {
  if (password == null || typeof password !== 'string') {
    return { ok: false, message: 'Password is required' };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    };
  }
  if (password.length > 128) {
    return { ok: false, message: 'Password is too long' };
  }
  return { ok: true };
}

function validateEmailFormat(email) {
  if (!email) {
    return { ok: false, message: 'Email is required' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, message: 'Invalid email format' };
  }
  return { ok: true };
}

module.exports = {
  normalizeEmail,
  normalizeName,
  validatePassword,
  validateEmailFormat,
  MIN_PASSWORD_LENGTH,
};
