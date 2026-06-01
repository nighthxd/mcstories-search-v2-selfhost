// search.js

// ─── STATE ───────────────────────────────────────────────────────────────────
let currentPage = 1;
let currentUser = null;   // null = not logged in; object = { username }

// ─── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

    // Theme toggle — apply localStorage immediately (avoids flash), then sync from server after auth
    applyTheme(localStorage.getItem('theme') || 'light');
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            const newTheme = document.body.classList.contains('dark-mode') ? 'light' : 'dark';
            applyTheme(newTheme);
            localStorage.setItem('theme', newTheme);
            if (currentUser) saveTheme(newTheme);
        });
    }

    // Restore saved filter checkboxes
    restoreFilterPreferences();

    // Enter key submits search
    document.getElementById('search-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') handleSearchClick();
    });

    // Show total stories indexed in the header
    fetchStoryCount();

    // Load auth state then restore URL (so read checkboxes render correctly)
    initAuth().then(() => restoreFromUrl());
});

// ─── AUTH ─────────────────────────────────────────────────────────────────────
async function initAuth() {
    try {
        const res  = await fetch('/api/auth/me');
        const data = await res.json();
        if (data.loggedIn) {
            currentUser = { username: data.username, isAdmin: data.isAdmin };
            // Server theme wins for logged-in users; keep localStorage in sync
            applyTheme(data.theme);
            localStorage.setItem('theme', data.theme);
        } else {
            currentUser = null;
        }
    } catch {
        currentUser = null;
    }
    renderAuthStatus();
}

function renderAuthStatus() {
    const bar = document.getElementById('auth-status');
    if (!bar) return;

    if (currentUser) {
        const adminLink = currentUser.isAdmin
            ? `<a href="/admin" class="auth-link-btn">Admin</a>`
            : '';
        bar.innerHTML =
            `<span class="auth-greeting">Hi, <strong>${escapeHtml(currentUser.username)}</strong></span>` +
            adminLink +
            `<button class="auth-logout-btn" onclick="logout()">Log out</button>`;
    } else {
        bar.innerHTML =
            `<a href="/login"    class="auth-link-btn">Log in</a>` +
            `<a href="/register" class="auth-link-btn">Register</a>`;
    }
}

async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    currentUser = null;
    renderAuthStatus();
    // Re-render results so checkboxes switch to disabled state
    performSearch(currentPage);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function applyTheme(theme) {
    document.body.classList.toggle('dark-mode', theme === 'dark');
}

function saveTheme(theme) {
    fetch('/api/preferences', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ theme })
    }).catch(() => {}); // fire-and-forget; failure is non-critical
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ─── STORY COUNT ──────────────────────────────────────────────────────────────
function fetchStoryCount() {
    fetch('/api/count')
        .then(r => r.json())
        .then(data => {
            const el = document.getElementById('story-count');
            if (el) el.textContent = `${Number(data.count).toLocaleString()} stories indexed`;
        })
        .catch(() => {});
}

// ─── FILTER PERSISTENCE ───────────────────────────────────────────────────────
function saveFilterPreferences() {
    const included = Array.from(document.querySelectorAll('input[name="include_tag"]:checked')).map(cb => cb.value);
    const excluded = Array.from(document.querySelectorAll('input[name="exclude_tag"]:checked')).map(cb => cb.value);
    localStorage.setItem('filter_include', JSON.stringify(included));
    localStorage.setItem('filter_exclude', JSON.stringify(excluded));
}

function restoreFilterPreferences() {
    try {
        const included = JSON.parse(localStorage.getItem('filter_include') || '[]');
        const excluded = JSON.parse(localStorage.getItem('filter_exclude') || '[]');
        included.forEach(tag => { const el = document.getElementById(`${tag}-in`); if (el) el.checked = true; });
        excluded.forEach(tag => { const el = document.getElementById(`${tag}-ex`); if (el) el.checked = true; });
    } catch (e) { /* ignore corrupt storage */ }
}

function clearFilters() {
    document.querySelectorAll('input[name="include_tag"], input[name="exclude_tag"]').forEach(cb => cb.checked = false);
    localStorage.removeItem('filter_include');
    localStorage.removeItem('filter_exclude');
}

// ─── URL STATE (shareable / bookmarkable searches) ────────────────────────────
function buildSearchParams(page) {
    const query    = document.getElementById('search-input').value.trim();
    const included = Array.from(document.querySelectorAll('input[name="include_tag"]:checked')).map(cb => cb.value);
    const excluded = Array.from(document.querySelectorAll('input[name="exclude_tag"]:checked')).map(cb => cb.value);

    const params = new URLSearchParams();
    if (query)           params.set('query',              query);
    if (included.length) params.set('categories',         included.join(','));
    if (excluded.length) params.set('excludedCategories', excluded.join(','));
    if (page > 1)        params.set('page',               page);
    return params;
}

function pushUrlState(page) {
    const params = buildSearchParams(page);
    history.pushState({}, '', params.toString() ? `?${params.toString()}` : window.location.pathname);
}

function restoreFromUrl() {
    const params  = new URLSearchParams(window.location.search);
    const query   = params.get('query');
    const cats    = params.get('categories');
    const excCats = params.get('excludedCategories');
    const page    = parseInt(params.get('page')) || 1;

    if (query) document.getElementById('search-input').value = query;

    if (cats) {
        cats.split(',').forEach(tag => {
            const el = document.getElementById(`${tag.trim()}-in`);
            if (el) el.checked = true;
        });
    }
    if (excCats) {
        excCats.split(',').forEach(tag => {
            const el = document.getElementById(`${tag.trim()}-ex`);
            if (el) el.checked = true;
        });
    }

    if (query || cats || excCats) {
        currentPage = page;
        performSearch(currentPage);
    }
}

// ─── SEARCH HANDLER ───────────────────────────────────────────────────────────
function handleSearchClick() {
    currentPage = 1;
    saveFilterPreferences();
    performSearch(1);
}

async function performSearch(page) {
    currentPage = page;
    const resultsContainer = document.getElementById('results-container');
    resultsContainer.innerHTML = '<p class="status-message">Loading results…</p>';

    const uiParams = buildSearchParams(page);
    uiParams.set('limit', '50');
    if (!uiParams.has('page')) uiParams.set('page', page);

    pushUrlState(page);

    try {
        const response = await fetch(`/api/search?${uiParams.toString()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const { stories, total, totalPages } = await response.json();

        resultsContainer.innerHTML = '';

        // ── Result count summary ──
        const countEl = document.createElement('p');
        countEl.className = 'result-count';
        if (total === 0) {
            countEl.textContent = 'No stories found matching your criteria.';
            resultsContainer.appendChild(countEl);
            return;
        }
        const start = (currentPage - 1) * 50 + 1;
        const end   = Math.min(currentPage * 50, total);
        countEl.textContent = `Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()} result${total !== 1 ? 's' : ''}`;
        resultsContainer.appendChild(countEl);

        // ── Story list ──
        const ul = document.createElement('ul');
        stories.forEach(story => ul.appendChild(renderStory(story)));
        resultsContainer.appendChild(ul);

        // ── Pagination controls ──
        if (totalPages > 1) {
            const pagination = document.createElement('div');
            pagination.className = 'pagination';

            const prevBtn = document.createElement('button');
            prevBtn.textContent = '← Previous';
            prevBtn.disabled    = currentPage <= 1;
            prevBtn.onclick     = () => { performSearch(currentPage - 1); window.scrollTo({ top: 0, behavior: 'smooth' }); };
            pagination.appendChild(prevBtn);

            const pageInfo = document.createElement('span');
            pageInfo.className   = 'page-info';
            pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
            pagination.appendChild(pageInfo);

            const nextBtn = document.createElement('button');
            nextBtn.textContent = 'Next →';
            nextBtn.disabled    = currentPage >= totalPages;
            nextBtn.onclick     = () => { performSearch(currentPage + 1); window.scrollTo({ top: 0, behavior: 'smooth' }); };
            pagination.appendChild(nextBtn);

            resultsContainer.appendChild(pagination);
        }

    } catch (error) {
        console.error('Error fetching stories:', error);
        resultsContainer.innerHTML = '<p class="status-message">Error loading stories. Please try again later.</p>';
    }
}

// ─── STORY RENDERER ───────────────────────────────────────────────────────────
function renderStory(story) {
    const li = document.createElement('li');
    if (story.is_read) li.classList.add('story-read');

    // ── Read checkbox (top-right corner) ──
    const checkWrapper = document.createElement('div');
    checkWrapper.className = 'read-checkbox-wrapper';

    const checkbox = document.createElement('input');
    checkbox.type      = 'checkbox';
    checkbox.checked   = story.is_read;
    checkbox.className = 'read-checkbox';
    checkbox.setAttribute('aria-label', 'Mark as read');

    if (!currentUser) {
        checkbox.disabled  = true;
        checkWrapper.title = 'Log in to save your reading progress';
    } else {
        checkbox.addEventListener('change', () => toggleRead(checkbox, li, story.id));
    }
    checkWrapper.appendChild(checkbox);
    li.appendChild(checkWrapper);

    // ── Story header (title + tags) ──
    const storyHeader = document.createElement('div');
    storyHeader.className = 'story-header';

    const a = document.createElement('a');
    if (/^https?:\/\//.test(story.url)) a.href = story.url;
    a.target      = '_blank';
    a.rel         = 'noopener noreferrer';
    a.textContent = story.title;
    storyHeader.appendChild(a);

    if (story.is_new) {
        const badge = document.createElement('span');
        badge.className   = 'new-badge';
        badge.textContent = 'NEW';
        storyHeader.appendChild(badge);
    }

    if (story.categories && story.categories.length > 0) {
        const categoriesSpan = document.createElement('span');
        categoriesSpan.className   = 'story-categories';
        categoriesSpan.textContent = ` (${story.categories.join(', ').toLowerCase()})`;
        storyHeader.appendChild(categoriesSpan);
    }
    li.appendChild(storyHeader);

    // ── Synopsis toggle ──
    if (story.synopsis && story.synopsis.trim().length > 0) {
        const synopsisDiv = document.createElement('div');
        synopsisDiv.className     = 'story-synopsis';
        synopsisDiv.textContent   = story.synopsis;
        synopsisDiv.style.display = 'none';
        li.appendChild(synopsisDiv);

        const toggleButton = document.createElement('button');
        toggleButton.className   = 'toggle-synopsis';
        toggleButton.textContent = 'Show Synopsis';
        toggleButton.onclick = () => {
            const isHidden = synopsisDiv.style.display === 'none';
            synopsisDiv.style.display = isHidden ? 'block' : 'none';
            toggleButton.textContent  = isHidden ? 'Hide Synopsis' : 'Show Synopsis';
        };
        li.appendChild(toggleButton);
    }

    return li;
}

// ─── RANDOM STORY ─────────────────────────────────────────────────────────────
async function handleRandomClick() {
    saveFilterPreferences();

    const included = Array.from(document.querySelectorAll('input[name="include_tag"]:checked')).map(cb => cb.value);
    const excluded = Array.from(document.querySelectorAll('input[name="exclude_tag"]:checked')).map(cb => cb.value);

    const params = new URLSearchParams();
    if (included.length) params.set('categories',         included.join(','));
    if (excluded.length) params.set('excludedCategories', excluded.join(','));

    const resultsContainer = document.getElementById('results-container');
    resultsContainer.innerHTML = '<p class="status-message">Finding a random story…</p>';

    try {
        const res = await fetch(`/api/random?${params.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { story } = await res.json();

        resultsContainer.innerHTML = '';

        const headerEl = document.createElement('p');
        headerEl.className = 'result-count';

        if (!story) {
            headerEl.textContent = 'No stories match your current filters.';
            resultsContainer.appendChild(headerEl);
            return;
        }

        const hasFilters = included.length > 0 || excluded.length > 0;
        headerEl.textContent = hasFilters ? '🎲 Random story (filtered)' : '🎲 Random story';
        resultsContainer.appendChild(headerEl);

        const ul = document.createElement('ul');
        ul.appendChild(renderStory(story));
        resultsContainer.appendChild(ul);

    } catch (err) {
        console.error('Random story error:', err);
        resultsContainer.innerHTML = '<p class="status-message">Failed to fetch a random story. Please try again.</p>';
    }
}

// ─── READ TOGGLE ──────────────────────────────────────────────────────────────
async function toggleRead(checkbox, li, storyId) {
    const nowRead = checkbox.checked;

    // Optimistic UI update
    li.classList.toggle('story-read', nowRead);

    try {
        const res = await fetch(`/api/reads/${storyId}`, {
            method: nowRead ? 'POST' : 'DELETE'
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
        console.error('Read toggle failed:', err);
        // Revert on failure
        checkbox.checked = !nowRead;
        li.classList.toggle('story-read', !nowRead);
    }
}
