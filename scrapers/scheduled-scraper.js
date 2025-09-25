// /scrapers/scheduled-scraper.js
const cheerio = require('cheerio');
const { tags } = require('../categories');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getDB() {
    return open({
        filename: process.env.DATABASE_PATH,
        driver: sqlite3.Database
    });
}

async function scrapeUrlWithCloudflare(urlToScrape, elementSelectors) {
    // ... (This function remains unchanged)
    const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN } = process.env;
    if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
        throw new Error("Cloudflare credentials are not set in the .env file.");
    }
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/browser-rendering/scrape`;
    const urlData = { url: urlToScrape, elements: elementSelectors };
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(urlData),
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to scrape ${urlToScrape}. Status: ${response.status}, Details: ${errorText}`);
    }
    const json = await response.json();
    if (!json.result || !Array.isArray(json.result) || json.result.length === 0) {
        throw new Error(`Cloudflare scrape returned no usable data for ${urlToScrape}`);
    }
    return json.result.flatMap(r => r.results || []);
}

async function runScraper() {
    const db = await getDB();
    try {
        await db.exec('PRAGMA journal_mode = WAL;');

        // --- MODIFIED: Fetch stories that already have a synopsis ---
        console.log("[Scraper] Fetching list of stories that already have a synopsis...");
        const existingStories = await db.all("SELECT url FROM stories WHERE synopsis IS NOT NULL AND synopsis != ''");
        const urlsToSkip = new Set(existingStories.map(s => s.url));
        console.log(`[Scraper] Found ${urlsToSkip.size} stories with existing synopses. They will be skipped.`);
        // --- END MODIFICATION ---

        const categoryKeys = Object.keys(tags);
        const state = await db.get('SELECT last_scraped_category_index FROM scrape_state WHERE id = 1');
        const nextIndex = (state.last_scraped_category_index + 1) % categoryKeys.length;
        
        const categoryToScrape = categoryKeys[nextIndex];
        const urlToScrape = tags[categoryToScrape];
        console.log(`[Scraper] Starting scheduled scrape for category #${nextIndex}: [${categoryToScrape.toUpperCase()}]`);

        const indexSelectors = [{ selector: "tr" }];
        const indexResults = await scrapeUrlWithCloudflare(urlToScrape, indexSelectors);
        const storiesOnPage = [];
        indexResults.forEach(item => {
            try {
                const $ = cheerio.load(item.html);
                const a = $('a');
                if (a.length > 0) {
                    const title = a.find('cite').text().trim() || a.text().trim();
                    const url = new URL(a.attr('href'), urlToScrape).href;
                    const text = item.text || '';
                    const parts = text.split('\t');
                    const categories = parts.length > 1 ? parts[1].split(' ').filter(Boolean).map(c => c.toLowerCase()) : [];
                    if (title && url && !url.includes('/Authors/') && !url.includes('/Tags/')) {
                        storiesOnPage.push({ title, url, categories });
                    }
                }
            } catch (e) { console.warn(`[Scraper] Skipping invalid snippet: ${e.message}`); }
        });

        // --- MODIFIED: Filter out the stories we already have ---
        const storiesToScrape = storiesOnPage.filter(story => !urlsToSkip.has(story.url));
        console.log(`[Scraper] Index page has ${storiesOnPage.length} stories. After filtering, ${storiesToScrape.length} new synopses will be scraped.`);
        // --- END MODIFICATION ---

        if (storiesToScrape.length === 0) {
            console.log("[Scraper] No new stories to scrape on this page. Moving to next category on next run.");
            await db.run('UPDATE scrape_state SET last_scraped_category_index = ? WHERE id = 1', nextIndex);
            await db.close();
            return;
        }

        console.log(`[Scraper] Fetching synopses and saving in batches of 10...`);
        let storiesBatch = [];
        const batchSize = 10;
        for (let i = 0; i < storiesToScrape.length; i++) {
            const story = storiesToScrape[i];
            try {
                console.log(`[DEBUG] Waiting 15s before scrape #${i + 1}...`);
                await delay(15000); 
                console.log(`[Scraper] Scraping synopsis for: ${story.title}`);
                const synopsisSelector = [{ selector: "section.synopsis" }];
                const storyPageResults = await scrapeUrlWithCloudflare(story.url, synopsisSelector);
                let synopsis = storyPageResults.length > 0 && storyPageResults[0].text ? storyPageResults[0].text.trim() : '';
                storiesBatch.push({ ...story, synopsis });
                console.log(`[DEBUG] Scraped: "${story.title}". Batch size: ${storiesBatch.length}.`);
            } catch (error) {
                console.error(`[Scraper] Failed to scrape synopsis for ${story.title}:`, error);
                storiesBatch.push({ ...story, synopsis: '' });
            }
            if (storiesBatch.length >= batchSize || i === storiesToScrape.length - 1) {
                console.log(`[Scraper] Saving batch of ${storiesBatch.length} stories...`);
                await saveStoriesToDB(storiesBatch, db);
                storiesBatch = [];
            }
        }
        await db.run('UPDATE scrape_state SET last_scraped_category_index = ? WHERE id = 1', nextIndex);
        console.log('[Scraper] Scrape and save successful for the entire category.');
    } catch (error) {
        console.error("[Scraper] Error in scheduled scrape handler:", error);
    } finally {
        console.log("[DEBUG] Reached 'finally' block, closing DB connection.");
        await db.close();
    }
}

async function saveStoriesToDB(stories, db) {
    // ... (This function remains unchanged)
    try {
        await db.exec('BEGIN TRANSACTION;');
        const stmt = await db.prepare(`
            INSERT INTO stories (url, title, synopsis, categories, last_scraped_at) 
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT(url) DO UPDATE SET
                title = excluded.title,
                synopsis = excluded.synopsis,
                categories = excluded.categories,
                last_scraped_at = datetime('now');
        `);
        for (const story of stories) {
            const categoriesString = story.categories.join(',');
            await stmt.run(story.url, story.title, story.synopsis, categoriesString);
        }
        await stmt.finalize();
        await db.exec('COMMIT;');
        console.log("[DEBUG] Batch save complete.");
    } catch (error) {
        console.error("[DEBUG] Error during DB transaction, rolling back.", error);
        await db.exec('ROLLBACK;');
        throw error; 
    }
}

module.exports = { runScraper };
