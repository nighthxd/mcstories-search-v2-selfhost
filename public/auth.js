// auth.js — shared by login.html and register.html

// ─── THEME TOGGLE ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            document.body.classList.toggle('dark-mode');
            localStorage.setItem('theme', document.body.classList.contains('dark-mode') ? 'dark' : 'light');
        });
        if (localStorage.getItem('theme') === 'dark') {
            document.body.classList.add('dark-mode');
        }
    }

    // Redirect to home if already logged in
    fetch('/api/auth/me')
        .then(r => r.json())
        .then(data => { if (data.loggedIn) window.location.href = '/'; })
        .catch(() => {});

    // Password strength indicator (register page only)
    const passwordInput   = document.getElementById('password');
    const strengthDisplay = document.getElementById('password-strength');
    if (passwordInput && strengthDisplay) {
        passwordInput.addEventListener('input', () => {
            strengthDisplay.innerHTML = getStrengthHtml(passwordInput.value);
        });
    }

    // Form submission
    const form = document.getElementById('auth-form');
    if (form) form.addEventListener('submit', handleSubmit);
});

// ─── PASSWORD STRENGTH ────────────────────────────────────────────────────────
function getStrengthHtml(pw) {
    if (!pw) return '';
    const checks = [
        { label: '12+ characters',           met: pw.length >= 12 },
        { label: 'Uppercase letter',          met: /[A-Z]/.test(pw) },
        { label: 'Number',                    met: /[0-9]/.test(pw) },
        { label: 'Special character',         met: /[^a-zA-Z0-9]/.test(pw) }
    ];
    return checks.map(c =>
        `<span class="${c.met ? 'req-met' : 'req-unmet'}">${c.met ? '✓' : '✗'} ${c.label}</span>`
    ).join('');
}

// ─── FORM SUBMIT ──────────────────────────────────────────────────────────────
async function handleSubmit(e) {
    e.preventDefault();

    const errorEl  = document.getElementById('auth-error');
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const isRegister = !!document.getElementById('confirm-password');

    errorEl.textContent = '';

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    // Client-side confirm-password check (register only)
    if (isRegister) {
        const confirm = document.getElementById('confirm-password').value;
        if (password !== confirm) {
            errorEl.textContent = 'Passwords do not match.';
            return;
        }
    }

    // Get Turnstile token
    const turnstileInput = document.querySelector('[name="cf-turnstile-response"]');
    const turnstileToken = turnstileInput ? turnstileInput.value : '';
    if (!turnstileToken) {
        errorEl.textContent = 'Please complete the bot verification.';
        return;
    }

    submitBtn.disabled = true;

    try {
        const endpoint = isRegister ? '/api/auth/register' : '/api/auth/login';
        const res = await fetch(endpoint, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ username, password, turnstileToken })
        });

        const data = await res.json();

        if (res.ok && data.success) {
            window.location.href = '/';
        } else {
            errorEl.textContent = data.error || 'Something went wrong. Please try again.';
            // Reset Turnstile widget so the user can retry
            if (window.turnstile) window.turnstile.reset();
        }
    } catch {
        errorEl.textContent = 'Network error. Please try again.';
        if (window.turnstile) window.turnstile.reset();
    } finally {
        submitBtn.disabled = false;
    }
}
