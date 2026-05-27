// server.js
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { execFile, fork } = require('child_process');
const bodyParser = require('body-parser');
const compression = require('compression');
const path = require('path');
const cron = require('node-cron');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
let db;

// --- MIDDLEWARE ---
// Gzip compress all responses
app.use(compression());

// --- WEBHOOK ---
// ⚠️ Raw body parser only for this route — required for HMAC signature verification
app.post('/git-webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
    console.log("Webhook received...");

    const secret = process.env.WEBHOOK_SECRET;
    const signature = req.headers['x-hub-signature-256'];
    const hash = `sha256=${crypto.createHmac('sha256', secret).update(req.body).digest('hex')}`;

    if (signature !== hash) {
        console.error("Webhook signature verification failed!");
        return res.status(401).send('Signature mismatch');
    }

    const data = JSON.parse(req.body);
    if (data.ref !== 'refs/heads/main') {
        console.log("Push was not to main branch, ignoring.");
        return res.status(200).send('Push was not to main, ignored.');
    }

    console.log("Signature verified. Running deployment script...");
    execFile('./deploy.sh', (error, stdout, stderr) => {
        if (error) { console.error(`execFile error: ${error}`); return; }
        if (stderr) { console.error(`stderr: ${stderr}`); return; }
        console.log(`stdout: ${stdout}`);
    });

    res.status(200).send('Deployment started.');
});

// --- DATABASE INIT ---
(async () => {
    db = await open({
        filename: process.env.DATABASE_PATH || './database/mcstories-db.sqlite',
        driver: sqlite3.Database
    });

    // Performance pragmas
    await db.exec('PRAGMA journal_mode = WAL;');      // Allow concurrent reads during scraper writes
    await db.exec('PRAGMA cache_size = -4000;');      // 4MB page cache (reduces disk I/O)
    await db.exec('PRAGMA synchronous = NORMAL;');    // Faster writes, still crash-safe with WAL

    // Index on categories for faster tag filtering
    await db.exec('CREATE INDEX IF NOT EXISTS idx_categories ON stories(categories);');

    // FTS5 virtual table for fast full-text search on title + synopsis
    await db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS stories_fts
        USING fts5(title, synopsis, content='stories', content_rowid='id');
    `);

    // Triggers to keep the FTS index in sync when the scraper inserts/updates stories
    await db.exec(`
        CREATE TRIGGER IF NOT EXISTS stories_ai AFTER INSERT ON stories BEGIN
            INSERT INTO stories_fts(rowid, title, synopsis)
            VALUES (new.id, new.title, new.synopsis);
        END;
    `);
    await db.exec(`
        CREATE TRIGGER IF NOT EXISTS stories_au AFTER UPDATE ON stories BEGIN
            INSERT INTO stories_fts(stories_fts, rowid, title, synopsis)
            VALUES ('delete', old.id, old.title, old.synopsis);
            INSERT INTO stories_fts(rowid, title, synopsis)
            VALUES (new.id, new.title, new.synopsis);
        END;
    `);
    await db.exec(`
        CREATE TRIGGER IF NOT EXISTS stories_ad AFTER DELETE ON stories BEGIN
            INSERT INTO stories_fts(stories_fts, rowid, title, synopsis)
            VALUES ('delete', old.id, old.title, old.synopsis);
        END;
    `);

    // One-time FTS index population: rebuild if FTS is behind the stories table.
    // This runs automatically on first deploy. Subsequent startups are instant (counts match).
    const ftsCount    = await db.get('SELECT COUNT(*) as count FROM stories_fts');
    const storiesCount = await db.get('SELECT COUNT(*) as count FROM stories');
    if (ftsCount.count < storiesCount.count) {
        console.log(`[DB] Building FTS index for ${storiesCount.count} stories (one-time, please wait)...`);
        await db.exec("INSERT INTO stories_fts(stories_fts) VALUES('rebuild');");
        console.log('[DB] FTS index built successfully.');
    }

    console.log(`[DB] Connected. ${storiesCount.count.toLocaleString()} stories in database.`);
})();

// --- STATIC FILES — 7-day browser cache for fonts, CSS, JS ---
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '7d',
    etag: true
}));

// --- API: Total story count (used by the frontend header) ---
app.get('/api/count', async (req, res) => {
    try {
        const result = await db.get('SELECT COUNT(*) as count FROM stories');
        res.json({ count: result.count });
    } catch (error) {
        console.error('Count API error:', error);
        res.status(500).json({ error: 'Failed to fetch story count.' });
    }
});

// --- API: Search with FTS, tag filtering, and pagination ---
app.get('/api/search', async (req, res) => {
    try {
        const { query, categories, excludedCategories, page = 1, limit = 50 } = req.query;

        const pageNum  = Math.max(1, parseInt(page)  || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 50));
        const offset   = (pageNum - 1) * limitNum;

        const includeTags = categories         ? categories.split(',').map(t => t.trim().toLowerCase()).filter(Boolean)         : [];
        const excludeTags = excludedCategories ? excludedCategories.split(',').map(t => t.trim().toLowerCase()).filter(Boolean) : [];

        // Sanitise query for FTS5: strip special chars, add prefix wildcard to each word
        const rawQuery = (query || '').trim();
        const ftsQuery = rawQuery
            .replace(/[^\w\s]/g, ' ')
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map(w => `${w}*`)
            .join(' ');

        const usesFts = ftsQuery.length > 0;

        let sql, countSql;
        const params      = [];
        const countParams = [];
        const tagClauses  = [];

        // Build tag filter clauses (shared between FTS and non-FTS paths)
        includeTags.forEach(tag => tagClauses.push({ sql: 'categories LIKE ?', val: `%${tag}%` }));
        excludeTags.forEach(tag => tagClauses.push({ sql: 'categories NOT LIKE ?', val: `%${tag}%` }));

        if (usesFts) {
            // Path A: Full-text search via FTS5, then filter tags
            const tagAndClause = tagClauses.length > 0
                ? ' AND ' + tagClauses.map(c => c.sql).join(' AND ')
                : '';

            sql = `
                SELECT s.url, s.title, s.synopsis, s.categories
                FROM stories s
                WHERE s.id IN (SELECT rowid FROM stories_fts WHERE stories_fts MATCH ?)
                ${tagAndClause}
                ORDER BY s.title
                LIMIT ? OFFSET ?
            `;
            countSql = `
                SELECT COUNT(*) as total
                FROM stories s
                WHERE s.id IN (SELECT rowid FROM stories_fts WHERE stories_fts MATCH ?)
                ${tagAndClause}
            `;
            params.push(ftsQuery);
            countParams.push(ftsQuery);
            tagClauses.forEach(c => { params.push(c.val); countParams.push(c.val); });

        } else {
            // Path B: Tag-only or browse-all (no text query)
            const whereClause = tagClauses.length > 0
                ? ' WHERE ' + tagClauses.map(c => c.sql).join(' AND ')
                : '';

            sql = `
                SELECT url, title, synopsis, categories
                FROM stories
                ${whereClause}
                ORDER BY title
                LIMIT ? OFFSET ?
            `;
            countSql = `SELECT COUNT(*) as total FROM stories ${whereClause}`;
            tagClauses.forEach(c => { params.push(c.val); countParams.push(c.val); });
        }

        params.push(limitNum, offset);

        // Run data query and count query in parallel
        const [stories, countResult] = await Promise.all([
            db.all(sql, params),
            db.get(countSql, countParams)
        ]);

        const formattedStories = stories.map(story => ({
            ...story,
            categories: story.categories ? story.categories.split(',') : []
        }));

        res.json({
            stories:    formattedStories,
            total:      countResult.total,
            page:       pageNum,
            limit:      limitNum,
            totalPages: Math.ceil(countResult.total / limitNum)
        });

    } catch (error) {
        console.error("API Search Error:", error);
        res.status(500).json({ error: 'Failed to fetch stories from the database.' });
    }
});

// --- SCHEDULED SCRAPER — runs as a forked child process to keep the web server responsive ---
const schedule = process.env.SCRAPE_SCHEDULE || '0 * * * *';
console.log(`[Cron] Scraper scheduled: "${schedule}"`);

cron.schedule(schedule, () => {
    console.log('[Cron] Triggered: forking scraper process...');
    const child = fork(path.join(__dirname, 'scrapers/scraper-worker.js'));
    child.on('exit', code => {
        if (code !== 0) {
            console.error(`[Cron] Scraper process exited with code ${code}`);
        } else {
            console.log('[Cron] Scraper process finished successfully.');
        }
    });
});

app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
