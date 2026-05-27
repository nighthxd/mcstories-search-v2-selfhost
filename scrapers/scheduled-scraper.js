// /scrapers/scheduled-scraper.js
const cheerio = require('cheerio');
const { tags } = require('../categories');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getDB() {
    return open({
        filename: process.env.DATABASE_PATH,
        driver:   sqlite3.Database
    });
}

async function scrapeUrlWithCloudflare(urlToScrape, elementSelectors) {
    const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN } = process.env;
    if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
        throw new Error('Cloudflare credentials are not set in the .env file.');
    }
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/browser-rendering/scrape`;
    const response = await fetch(endpoint, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url: urlToScrape, elements: elementSelectors })
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

/** Parse scraped <tr> rows from a tag/title index page into story objects. */
function parseIndexResults(indexResults, baseUrl) {
    const stories = [];
    indexResults.forEach(item => {
        try {
            const $ = cheerio.load(item.html);
            const a = $('a');
            if (a.length > 0) {
                const title = a.find('cite').text().trim() || a.text().trim();
                const url   = new URL(a.attr('href'), baseUrl).href;
                const parts = (item.text || '').split('\t');
                const categories = parts.length > 1
                    ? parts[1].split(' ').filter(Boolean).map(c => c.toLowerCase())
                    : [];
                if (title && url && !url.includes('/Authors/') && !url.includes('/Tags/')) {
                    stories.push({ title, url, categories });
                }
            }
        } catch (e) {
            console.warn(`[Scraper] Skipping invalid row: ${e.message}`);
        }
    });
    return stories;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function runScraper() {
    const db = await getDB();
    try {
        await db.exec('PRAGMA journal_mode = WAL;');
        await db.exec('PRAGMA foreign_keys = ON;');

        const categoryKeys = Object.keys(tags);
        const state      = await db.get('SELECT last_scraped_category_index FROM scrape_state WHERE id = 1');
        const nextIndex  = (state.last_scraped_category_index + 1) % categoryKeys.length;
        const category   = categoryKeys[nextIndex];
        const pageUrl    = tags[category];

        console.log(`[Scraper] Category #${nextIndex} [${category.toUpperCase()}] → ${pageUrl}`);

        // ── 1. Scrape the tag index page ──────────────────────────────────────
        const rawResults   = await scrapeUrlWithCloudflare(pageUrl, [{ selector: 'tr' }]);
        const storiesOnPage = parseIndexResults(rawResults, pageUrl);
        console.log(`[Scraper] ${storiesOnPage.length} stories found on page.`);

        if (storiesOnPage.length === 0) {
            console.log('[Scraper] Empty page — skipping, advancing category index.');
            await db.run('UPDATE scrape_state SET last_scraped_category_index = ? WHERE id = 1', nextIndex);
            return;
        }

        // ── 2. Upsert metadata for ALL stories (title, categories, last_seen_at) ──
        // Synopsis is intentionally omitted from the ON CONFLICT SET so existing
        // synopses are never overwritten by this step.
        await upsertMetadata(storiesOnPage, db);
        console.log(`[Scraper] Metadata upserted for ${storiesOnPage.length} stories.`);

        // ── 3. Fetch synopsis only for stories that don't have one yet ─────────
        const pageUrls      = storiesOnPage.map(s => s.url);
        const needSynopsis  = await getUrlsMissingSynopsis(pageUrls, db);
        console.log(`[Scraper] ${needSynopsis.size} stories need a synopsis fetched.`);

        if (needSynopsis.size > 0) {
            const toFetch = storiesOnPage.filter(s => needSynopsis.has(s.url));
            await fetchAndSaveSynopses(toFetch, db);
        }

        // ── 4. Prune stories deleted from MCStories ───────────────────────────
        // A story with last_seen_at older than 7 days hasn't appeared on any tag
        // page in that time. A full scrape cycle completes in ~26 hours, so
        // 7 days is a very conservative buffer before deleting.
        // Stories with NULL last_seen_at (added before this migration) are skipped.
        const pruned = await pruneStaleStories(db);
        if (pruned > 0) {
            console.log(`[Scraper] Pruned ${pruned} stale stories no longer on MCStories.`);
        }

        await db.run('UPDATE scrape_state SET last_scraped_category_index = ? WHERE id = 1', nextIndex);
        console.log('[Scraper] Run complete.');

    } catch (error) {
        console.error('[Scraper] Fatal error:', error);
    } finally {
        await db.close();
    }
}

// ─── DB HELPERS ───────────────────────────────────────────────────────────────

/**
 * Upsert title + categories + last_seen_at for every story on the page.
 * On conflict: updates title/categories/last_seen_at only — synopsis is preserved.
 */
async function upsertMetadata(stories, db) {
    await db.exec('BEGIN TRANSACTION;');
    try {
        // New rows get synopsis = '' so we never violate a NOT NULL constraint.
        // Existing rows: ON CONFLICT handler does NOT touch synopsis.
        const stmt = await db.prepare(`
            INSERT INTO stories (url, title, synopsis, categories, last_seen_at, last_scraped_at)
            VALUES (?, ?, '', ?, datetime('now'), datetime('now'))
            ON CONFLICT(url) DO UPDATE SET
                title        = excluded.title,
                categories   = excluded.categories,
                last_seen_at = datetime('now')
        `);
        for (const story of stories) {
            await stmt.run(story.url, story.title, story.categories.join(','));
        }
        await stmt.finalize();
        await db.exec('COMMIT;');
    } catch (err) {
        await db.exec('ROLLBACK;');
        throw err;
    }
}

/**
 * Returns a Set of URLs (from the given list) that have no synopsis in the DB.
 * Uses a temporary table to avoid hitting SQLite's parameter-count limit on
 * large tag pages (mc has 17 000+ entries).
 */
async function getUrlsMissingSynopsis(urls, db) {
    // Temp tables are connection-scoped — safe for concurrent runs.
    await db.exec('CREATE TEMPORARY TABLE IF NOT EXISTS _page_urls (url TEXT PRIMARY KEY);');
    await db.exec('DELETE FROM _page_urls;');

    const ins = await db.prepare('INSERT OR IGNORE INTO _page_urls VALUES (?)');
    for (const url of urls) await ins.run(url);
    await ins.finalize();

    const rows = await db.all(`
        SELECT url FROM stories
        WHERE url IN (SELECT url FROM _page_urls)
          AND (synopsis IS NULL OR synopsis = '')
    `);
    await db.exec('DROP TABLE IF EXISTS _page_urls;');
    return new Set(rows.map(r => r.url));
}

/**
 * Fetch each story's synopsis page and save results in batches of 10.
 */
async function fetchAndSaveSynopses(stories, db) {
    let batch = [];
    for (let i = 0; i < stories.length; i++) {
        const story = stories[i];
        try {
            console.log(`[DEBUG] Waiting 15s before synopsis fetch ${i + 1}/${stories.length}…`);
            await delay(15000);
            console.log(`[Scraper] Fetching synopsis: "${story.title}"`);
            const results  = await scrapeUrlWithCloudflare(story.url, [{ selector: 'section.synopsis' }]);
            const synopsis = results.length > 0 && results[0].text ? results[0].text.trim() : '';
            batch.push({ url: story.url, synopsis });
        } catch (err) {
            console.error(`[Scraper] Synopsis fetch failed for "${story.title}":`, err.message);
            batch.push({ url: story.url, synopsis: '' });
        }

        if (batch.length >= 10 || i === stories.length - 1) {
            await saveSynopses(batch, db);
            console.log(`[Scraper] Saved batch of ${batch.length} synopses.`);
            batch = [];
        }
    }
}

async function saveSynopses(batch, db) {
    await db.exec('BEGIN TRANSACTION;');
    try {
        const stmt = await db.prepare(
            `UPDATE stories SET synopsis = ?, last_scraped_at = datetime('now') WHERE url = ?`
        );
        for (const { url, synopsis } of batch) await stmt.run(synopsis, url);
        await stmt.finalize();
        await db.exec('COMMIT;');
    } catch (err) {
        await db.exec('ROLLBACK;');
        throw err;
    }
}

/**
 * Delete stories whose last_seen_at is older than 7 days.
 * These have not appeared on any MCStories tag page in that window and are
 * almost certainly removed from the site.
 *
 * Cascade: user_reads rows are automatically removed via the FK ON DELETE CASCADE.
 * FTS:     the stories_ad trigger keeps the FTS index in sync automatically.
 *
 * Stories with NULL last_seen_at (scraped before this migration) are left alone —
 * they will accumulate last_seen_at values naturally over the next full cycle.
 */
async function pruneStaleStories(db) {
    const result = await db.run(`
        DELETE FROM stories
        WHERE last_seen_at IS NOT NULL
          AND last_seen_at < datetime('now', '-7 days')
    `);
    return result.changes;
}

module.exports = { runScraper };
