// lib/validators.js  — pure validation helpers (no side effects, easily unit-tested)

/** 3–20 chars, alphanumeric + underscores only. */
function validateUsername(u) {
    return typeof u === 'string' && /^[a-zA-Z0-9_]{3,20}$/.test(u);
}

/**
 * Password must be:
 *   • At least 12 characters
 *   • Contains at least one uppercase letter
 *   • Contains at least one digit
 *   • Contains at least one special (non-alphanumeric) character
 */
function validatePassword(p) {
    if (typeof p !== 'string' || p.length < 12) return false;
    if (!/[A-Z]/.test(p))        return false;
    if (!/[0-9]/.test(p))        return false;
    if (!/[^a-zA-Z0-9]/.test(p)) return false;
    return true;
}

module.exports = { validateUsername, validatePassword };
