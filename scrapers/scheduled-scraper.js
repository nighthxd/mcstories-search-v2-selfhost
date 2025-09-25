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
        console.error("Cloudflare scrape raw response:", JSON.stringify(json, null, 2));
        throw new Error(`Cloudflare scrape returned no usable data for ${urlToScrape}`);
    }
    return json.result.flatMap(r => r.results || []);
}

async function runScraper() {
    const db = await getDB();
    try {
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
            } catch (e) {
                console.warn(`[Scraper] Skipping invalid snippet from index page: ${e.message}`);
            }
        });

        if (storiesOnPage.length === 0) {
            console.log("[Scraper] No stories found on this page. Moving to next category on next run.");
            // We still update the state to avoid getting stuck on an empty category
            await db.run('UPDATE scrape_state SET last_scraped_category_index = ? WHERE id = 1', nextIndex);
            await db.close();
            return;
        }

        // --- MODIFIED: Batch saving logic ---
        console.log(`[Scraper] Found ${storiesOnPage.length} stories. Fetching synopses and saving in batches of 10..`);
        let storiesBatch = [];
        const batchSize = 10;

        for (let i = 0; i < storiesOnPage.length; i++) {
            const story = storiesOnPage[i];
            try {
                console.log(`[DEBUG] Waiting 15 seconds before scrape #${i + 1}...`);
                await delay(15000); 

                console.log(`[Scraper] Scraping synopsis for: ${story.title}`);
                const synopsisSelector = [{ selector: "section.synopsis" }];
                const storyPageResults = await scrapeUrlWithCloudflare(story.url, synopsisSelector);

                let synopsis = storyPageResults.length > 0 && storyPageResults[0].text ? storyPageResults[0].text.trim() : '';
                
                // Add the completed story to the current batch
                storiesBatch.push({ ...story, synopsis });
                console.log(`[DEBUG] Scraped: "${story.title}". Batch size is now ${storiesBatch.length}.`);

            } catch (error) {
                console.error(`[Scraper] Failed to scrape synopsis for ${story.title}:`, error);
                // Still add the story but with an empty synopsis so we don't lose it
                storiesBatch.push({ ...story, synopsis: '' });
            }

            // Save the batch if it's full OR if we're at the very last story
            if (storiesBatch.length >= batchSize || i === storiesOnPage.length - 1) {
                console.log(`[Scraper] Saving a batch of ${storiesBatch.length} stories to the database...`);
                await saveStoriesToDB(storiesBatch, db);
                console.log(`[DEBUG] Batch save complete.`);
                storiesBatch = []; // Clear the batch for the next set
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
    console.log(`[DEBUG] Inside saveStoriesToDB function with ${stories.length} stories.`);
    
    // --- MODIFIED: Explicit transaction control for safety ---
    try {
        console.log("[DEBUG] Beginning database transaction...");
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

        console.log("[DEBUG] Committing transaction...");
        await db.exec('COMMIT;');

    } catch (error) {
        // This will catch any errors during the transaction and log them.
        console.error("[DEBUG] Error during database transaction, rolling back.", error);
        await db.exec('ROLLBACK;');
        // Re-throw the error so the main handler knows something went wrong.
        throw error; 
    }
}

module.exports = { runScraper };