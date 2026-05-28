// admin.js

let currentAdminId = null;   // session user's ID (to disable self-action buttons)
let resetTargetId  = null;   // user ID currently open in the reset-password modal

// ─── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

    // Apply localStorage theme immediately (avoids flash before /api/auth/me resolves)
    applyTheme(localStorage.getItem('theme') || 'light');
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            const newTheme = document.body.classList.contains('dark-mode') ? 'light' : 'dark';
            applyTheme(newTheme);
            localStorage.setItem('theme', newTheme);
            saveTheme(newTheme);
        });
    }

    // Verify admin session; redirect if not admin (belt-and-suspenders — server already checks)
    fetch('/api/auth/me')
        .then(r => r.json())
        .then(data => {
            if (!data.loggedIn || !data.isAdmin) {
                window.location.href = '/';
                return;
            }
            // Sync theme from server (authoritative for logged-in users)
            applyTheme(data.theme);
            localStorage.setItem('theme', data.theme);
            // We need the user's own ID to disable self-action buttons.
            // Store it by loading users and identifying the current username.
            loadUsers(data.username);
        })
        .catch(() => { window.location.href = '/'; });
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function applyTheme(theme) {
    document.body.classList.toggle('dark-mode', theme === 'dark');
}

function saveTheme(theme) {
    fetch('/api/preferences', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ theme })
    }).catch(() => {}); // fire-and-forget
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#39;');
}

function showFeedback(elementId, message, isError = true) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = message;
    el.className   = `admin-feedback ${isError ? 'admin-feedback-error' : 'admin-feedback-success'}`;
    if (!isError) setTimeout(() => { el.textContent = ''; }, 4000);
}

// ─── LOAD USERS TABLE ─────────────────────────────────────────────────────────
async function loadUsers(currentUsername) {
    const container = document.getElementById('users-table-container');
    try {
        const res  = await fetch('/api/admin/users');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load users.');

        const { users } = data;

        // Identify current admin's ID
        const self = users.find(u => u.username.toLowerCase() === currentUsername.toLowerCase());
        if (self) currentAdminId = self.id;

        if (users.length === 0) {
            container.innerHTML = '<p class="status-message">No users found.</p>';
            return;
        }

        const table = document.createElement('table');
        table.className = 'admin-table';
        table.innerHTML = `
            <thead>
                <tr>
                    <th>Username</th>
                    <th>Created</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Reads</th>
                    <th>Actions</th>
                </tr>
            </thead>
        `;

        const tbody = document.createElement('tbody');
        users.forEach(user => {
            const isSelf      = user.id === currentAdminId;
            const createdDate = new Date(user.created_at).toLocaleDateString(undefined, {
                year: 'numeric', month: 'short', day: 'numeric'
            });

            const tr = document.createElement('tr');
            if (user.is_suspended) tr.classList.add('admin-row-suspended');

            tr.innerHTML = `
                <td class="admin-col-username">${escapeHtml(user.username)}${isSelf ? ' <span class="admin-self-badge">(you)</span>' : ''}</td>
                <td class="admin-col-date">${escapeHtml(createdDate)}</td>
                <td>${user.is_admin
                    ? '<span class="admin-badge admin-badge-admin">Admin</span>'
                    : '<span class="admin-badge admin-badge-user">User</span>'}</td>
                <td>${user.is_suspended
                    ? '<span class="admin-badge admin-badge-suspended">Suspended</span>'
                    : '<span class="admin-badge admin-badge-active">Active</span>'}</td>
                <td class="admin-col-reads">${user.read_count.toLocaleString()}</td>
                <td class="admin-col-actions">
                    <button class="admin-btn admin-btn-sm admin-btn-reset"
                            onclick="openResetModal(${user.id}, '${escapeHtml(user.username)}')"
                            ${isSelf ? 'disabled title="Cannot modify your own account"' : ''}>
                        Reset PW
                    </button>
                    <button class="admin-btn admin-btn-sm ${user.is_suspended ? 'admin-btn-unsuspend' : 'admin-btn-suspend'}"
                            onclick="toggleSuspend(${user.id}, ${user.is_suspended ? 'true' : 'false'})"
                            ${isSelf ? 'disabled title="Cannot modify your own account"' : ''}>
                        ${user.is_suspended ? 'Unsuspend' : 'Suspend'}
                    </button>
                    <button class="admin-btn admin-btn-sm admin-btn-delete"
                            onclick="deleteUser(${user.id}, '${escapeHtml(user.username)}')"
                            ${isSelf ? 'disabled title="Cannot delete your own account"' : ''}>
                        Delete
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        container.innerHTML = '';
        container.appendChild(table);

    } catch (err) {
        container.innerHTML = `<p class="admin-feedback admin-feedback-error">${escapeHtml(err.message)}</p>`;
    }
}

// ─── ADD USER ─────────────────────────────────────────────────────────────────
async function addUser(event) {
    event.preventDefault();
    showFeedback('add-user-error',   '');
    showFeedback('add-user-success', '');

    const username = document.getElementById('new-username').value.trim();
    const password = document.getElementById('new-password').value;

    try {
        const res  = await fetch('/api/admin/users', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) {
            showFeedback('add-user-error', data.error || 'Failed to create user.', true);
            return;
        }
        document.getElementById('new-username').value = '';
        document.getElementById('new-password').value = '';
        showFeedback('add-user-success', `User "${username}" created successfully.`, false);
        loadUsers(getCurrentUsername());
    } catch {
        showFeedback('add-user-error', 'Network error. Please try again.', true);
    }
}

// Helper to re-fetch current username for reload calls
function getCurrentUsername() {
    // Grab it from the table row with "(you)" label
    const selfCell = document.querySelector('.admin-self-badge');
    if (selfCell) {
        const row = selfCell.closest('tr');
        const cell = row ? row.querySelector('.admin-col-username') : null;
        if (cell) return cell.textContent.replace(' (you)', '').trim();
    }
    return '';
}

// ─── DELETE USER ──────────────────────────────────────────────────────────────
async function deleteUser(userId, username) {
    if (!confirm(`Permanently delete user "${username}" and all their data?\n\nThis cannot be undone.`)) return;
    try {
        const res  = await fetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) {
            alert(data.error || 'Failed to delete user.');
            return;
        }
        loadUsers(getCurrentUsername());
    } catch {
        alert('Network error. Please try again.');
    }
}

// ─── SUSPEND / UNSUSPEND ──────────────────────────────────────────────────────
async function toggleSuspend(userId, currentlySuspended) {
    const action = currentlySuspended ? 'unsuspend' : 'suspend';
    try {
        const res  = await fetch(`/api/admin/users/${userId}/suspend`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ suspended: !currentlySuspended })
        });
        const data = await res.json();
        if (!res.ok) {
            alert(data.error || `Failed to ${action} user.`);
            return;
        }
        loadUsers(getCurrentUsername());
    } catch {
        alert('Network error. Please try again.');
    }
}

// ─── RESET PASSWORD MODAL ─────────────────────────────────────────────────────
function openResetModal(userId, username) {
    resetTargetId = userId;
    document.getElementById('reset-modal-user').textContent  = `User: ${username}`;
    document.getElementById('reset-password-input').value    = '';
    document.getElementById('reset-modal-error').textContent = '';
    document.getElementById('reset-modal-overlay').style.display = 'flex';
    document.getElementById('reset-password-input').focus();
}

function closeResetModal() {
    document.getElementById('reset-modal-overlay').style.display = 'none';
    resetTargetId = null;
}

async function confirmResetPassword() {
    const newPassword = document.getElementById('reset-password-input').value;
    const errorEl     = document.getElementById('reset-modal-error');
    errorEl.textContent = '';

    try {
        const res  = await fetch(`/api/admin/users/${resetTargetId}/reset-password`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ newPassword })
        });
        const data = await res.json();
        if (!res.ok) {
            errorEl.textContent = data.error || 'Failed to reset password.';
            return;
        }
        closeResetModal();
        // Brief success notice in the table area
        const container = document.getElementById('users-table-container');
        const note = document.createElement('p');
        note.className   = 'admin-feedback admin-feedback-success';
        note.textContent = 'Password updated successfully.';
        container.prepend(note);
        setTimeout(() => note.remove(), 4000);
    } catch {
        errorEl.textContent = 'Network error. Please try again.';
    }
}

// Close modal on overlay click
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('reset-modal-overlay').addEventListener('click', e => {
        if (e.target === e.currentTarget) closeResetModal();
    });

    // Close modal on Escape key
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeResetModal();
    });
});
