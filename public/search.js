// search.js

// ─── STATE ───────────────────────────────────────────────────────────────────
let currentPage = 1;

// ─── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

    // Theme toggle
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

    // Restore saved filter checkboxes
    restoreFilterPreferences();

    // Enter key submits search
    document.getElementById('search-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') handleSearchClick();
    });

    // Show total stories indexed in the header
    fetchStoryCount();

    // If the page was loaded with a URL query string, restore and auto-run the search
    restoreFromUrl();
});

// ─── STORY COUNT ──────────────────────────────────────────────────────────────
function fetchStoryCount() {
    fetch('/api/count')
        .then(r => r.json())
        .then(data => {
            const el = document.getElementById('story-count');
            if (el) el.textContent = `${Number(data.count).toLocaleString()} stories indexed`;
        })
        .catch(() => {}); // Silently fail — non-critical
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
    const params = new URLSearchParams(window.location.search);

    const query    = params.get('query');
    const cats     = params.get('categories');
    const excCats  = params.get('excludedCategories');
    const page     = parseInt(params.get('page')) || 1;

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

    // Auto-run if URL contained search parameters
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

    // Build API query params (includes limit)
    const uiParams = buildSearchParams(page);
    uiParams.set('limit', '50');
    if (!uiParams.has('page')) uiParams.set('page', page);

    // Update the browser URL bar
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
        stories.forEach(story => {
            const li = document.createElement('li');

            const storyHeader = document.createElement('div');
            storyHeader.className = 'story-header';

            const a = document.createElement('a');
            a.href = story.url;
            a.textContent = story.title;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            storyHeader.appendChild(a);

            if (story.categories && story.categories.length > 0) {
                const categoriesSpan = document.createElement('span');
                categoriesSpan.className = 'story-categories';
                categoriesSpan.textContent = ` (${story.categories.join(', ').toLowerCase()})`;
                storyHeader.appendChild(categoriesSpan);
            }
            li.appendChild(storyHeader);

            if (story.synopsis && story.synopsis.trim().length > 0) {
                const synopsisDiv = document.createElement('div');
                synopsisDiv.className = 'story-synopsis';
                synopsisDiv.textContent = story.synopsis;
                synopsisDiv.style.display = 'none';
                li.appendChild(synopsisDiv);

                const toggleButton = document.createElement('button');
                toggleButton.className = 'toggle-synopsis';
                toggleButton.textContent = 'Show Synopsis';
                toggleButton.onclick = () => {
                    const isHidden = synopsisDiv.style.display === 'none';
                    synopsisDiv.style.display = isHidden ? 'block' : 'none';
                    toggleButton.textContent = isHidden ? 'Hide Synopsis' : 'Show Synopsis';
                };
                li.appendChild(toggleButton);
            }

            ul.appendChild(li);
        });
        resultsContainer.appendChild(ul);

        // ── Pagination controls ──
        if (totalPages > 1) {
            const pagination = document.createElement('div');
            pagination.className = 'pagination';

            const prevBtn = document.createElement('button');
            prevBtn.textContent = '← Previous';
            prevBtn.disabled = currentPage <= 1;
            prevBtn.onclick = () => { performSearch(currentPage - 1); window.scrollTo({ top: 0, behavior: 'smooth' }); };
            pagination.appendChild(prevBtn);

            const pageInfo = document.createElement('span');
            pageInfo.className = 'page-info';
            pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
            pagination.appendChild(pageInfo);

            const nextBtn = document.createElement('button');
            nextBtn.textContent = 'Next →';
            nextBtn.disabled = currentPage >= totalPages;
            nextBtn.onclick = () => { performSearch(currentPage + 1); window.scrollTo({ top: 0, behavior: 'smooth' }); };
            pagination.appendChild(nextBtn);

            resultsContainer.appendChild(pagination);
        }

    } catch (error) {
        console.error('Error fetching stories:', error);
        resultsContainer.innerHTML = '<p class="status-message">Error loading stories. Please try again later.</p>';
    }
}
