// tests/unit/validators.test.js
const { validateUsername, validatePassword } = require('../../lib/validators');

// ─────────────────────────────────────────────────────────────────────────────
describe('validateUsername', () => {

    // --- valid inputs ---
    test('accepts a normal 5-char alphanumeric username', () => {
        expect(validateUsername('hello')).toBe(true);
    });
    test('accepts underscores', () => {
        expect(validateUsername('user_name')).toBe(true);
    });
    test('accepts mixed case', () => {
        expect(validateUsername('UserABC')).toBe(true);
    });
    test('accepts minimum length (3)', () => {
        expect(validateUsername('abc')).toBe(true);
    });
    test('accepts maximum length (20)', () => {
        expect(validateUsername('a'.repeat(20))).toBe(true);
    });
    test('accepts digits', () => {
        expect(validateUsername('user123')).toBe(true);
    });
    test('accepts underscore-only prefix', () => {
        expect(validateUsername('___usr')).toBe(true);
    });

    // --- too short ---
    test('rejects empty string', () => {
        expect(validateUsername('')).toBe(false);
    });
    test('rejects 1-char username', () => {
        expect(validateUsername('a')).toBe(false);
    });
    test('rejects 2-char username', () => {
        expect(validateUsername('ab')).toBe(false);
    });

    // --- too long ---
    test('rejects 21-char username', () => {
        expect(validateUsername('a'.repeat(21))).toBe(false);
    });
    test('rejects very long string', () => {
        expect(validateUsername('a'.repeat(100))).toBe(false);
    });

    // --- invalid characters ---
    test('rejects spaces', () => {
        expect(validateUsername('user name')).toBe(false);
    });
    test('rejects hyphens', () => {
        expect(validateUsername('user-name')).toBe(false);
    });
    test('rejects at-sign', () => {
        expect(validateUsername('user@domain')).toBe(false);
    });
    test('rejects dots', () => {
        expect(validateUsername('first.last')).toBe(false);
    });
    test('rejects unicode letters', () => {
        expect(validateUsername('üser')).toBe(false);
    });

    // --- type safety ---
    test('rejects null', () => {
        expect(validateUsername(null)).toBe(false);
    });
    test('rejects undefined', () => {
        expect(validateUsername(undefined)).toBe(false);
    });
    test('rejects number', () => {
        expect(validateUsername(12345)).toBe(false);
    });
    test('rejects object', () => {
        expect(validateUsername({})).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('validatePassword', () => {

    // --- valid inputs ---
    test('accepts a fully compliant password', () => {
        expect(validatePassword('Secure@Pass1!')).toBe(true);
    });
    test('accepts exactly 12 chars with all requirements', () => {
        expect(validatePassword('Abcdefgh1!XY')).toBe(true);  // 12 chars
    });
    test('accepts long passwords', () => {
        expect(validatePassword('MyVeryLongAndSecure1!Password')).toBe(true);
    });
    test('accepts multiple special chars', () => {
        expect(validatePassword('Hello@World1!!')).toBe(true);
    });

    // --- too short ---
    test('rejects 11-char password even if otherwise valid', () => {
        expect(validatePassword('ShortPass1!')).toBe(false);  // 11 chars
    });
    test('rejects empty string', () => {
        expect(validatePassword('')).toBe(false);
    });

    // --- missing uppercase ---
    test('rejects all-lowercase (no uppercase)', () => {
        expect(validatePassword('nouppercase1!')).toBe(false);
    });
    test('rejects when only digits and lower', () => {
        expect(validatePassword('password1234!')).toBe(false);
    });

    // --- missing digit ---
    test('rejects no-digit password', () => {
        expect(validatePassword('NoDigitHere!!')).toBe(false);
    });

    // --- missing special character ---
    test('rejects no-special-char password', () => {
        expect(validatePassword('NoSpecialChar1')).toBe(false);
    });
    test('rejects alphanumeric only (12+ chars)', () => {
        expect(validatePassword('AlphaNumeric1')).toBe(false);
    });

    // --- type safety ---
    test('rejects null', () => {
        expect(validatePassword(null)).toBe(false);
    });
    test('rejects undefined', () => {
        expect(validatePassword(undefined)).toBe(false);
    });
    test('rejects number', () => {
        expect(validatePassword(123456789012)).toBe(false);
    });
    test('rejects array', () => {
        expect(validatePassword(['P@ssw0rd!Sec'])).toBe(false);
    });
});
