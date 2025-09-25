// search.js
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
});

async function handleSearchClick() {
    const searchInput = document.getElementById('search-input');
    const query = searchInput.value.trim();
    const resultsContainer = document.getElementById('results-container');
    resultsContainer.innerHTML = 'Loading results...';

    const includedTags = Array.from(document.querySelectorAll('input[name="include_tag"]:checked')).map(cb => cb.value);
    const excludedTags = Array.from(document.querySelectorAll('input[name="exclude_tag"]:checked')).map(cb => cb.value);

    // This logic is simplified: we always call the same search function
    const params = new URLSearchParams();
    if (query) params.append('query', query);
    if (includedTags.length > 0) params.append('categories', includedTags.join(','));
    if (excludedTags.length > 0) params.append('excludedCategories', excludedTags.join(','));
    
    const apiUrl = `/api/search?${params.toString()}`;

    try {
        const response = await fetch(apiUrl);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const stories = await response.json();

        resultsContainer.innerHTML = ''; // Clear "Loading results..."

        if (stories.length === 0) {
            resultsContainer.innerHTML = '<p>No stories found in the database matching your criteria.</p>';
        } else {
            const ul = document.createElement('ul');
            stories.forEach(story => {
                console.log(story);
                const li = document.createElement('li');
                
                const storyHeader = document.createElement('div');
                storyHeader.className = 'story-header';
                const a = document.createElement('a');
                a.href = story.url;
                a.textContent = story.title;
                a.target = "_blank";
                storyHeader.appendChild(a);

                if (story.categories && story.categories.length > 0) {
                    const categoriesSpan = document.createElement('span');
                    categoriesSpan.className = 'story-categories';
                    categoriesSpan.textContent = ` (${story.categories.join(', ').toLowerCase()})`;
                    storyHeader.appendChild(categoriesSpan);
                }
                li.appendChild(storyHeader);

                // If synopsis exists, create the synopsis div and toggle button
                if (story.synopsis && story.synopsis.trim().length > 0) {
                    const synopsisDiv = document.createElement('div');
                    synopsisDiv.className = 'story-synopsis';
                    synopsisDiv.textContent = story.synopsis;
                    synopsisDiv.style.display = 'none'; // Initially hidden
                    li.appendChild(synopsisDiv);

                    const toggleButton = document.createElement('button');
                    toggleButton.className = 'toggle-synopsis';
                    toggleButton.textContent = 'Show Synopsis';
                    
                    // The button now only shows/hides the div. No more fetching.
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
        }
    } catch (error) {
        console.error('Error fetching stories:', error);
        resultsContainer.innerHTML = '<p>Error loading stories. Please try again later.</p>';
    }
}