// server.js
require('dotenv').config();
const express    = require('express');
const crypto     = require('crypto');
const https      = require('https');
const { execFile, fork } = require('child_process');
const bodyParser = require('body-parser');
const compression = require('compression');
const path       = require('path');
const cron       = require('node-cron');
const { open }   = require('sqlite');
const sqlite3    = require('sqlite3');
const bcrypt     = require('bcrypt');
const session    = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const rateLimit  = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;
let db;

// --- TRUST PROXY (required for Nginx + secure cookies + real IP for rate limiting) ---
app.set('trust proxy', 1);

// --- MIDDLEWARE ---
app.use(compression());

// --- SESSION ---
app.use(session({
    store: new SQLiteStore({
        db:  'sessions.db',
        dir: path.join(__dirname, 'database')
    }),
    secret:            process.env.SESSION_SECRET,
    resave:            false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge:   60 * 24 * 60 * 60 * 1000   // 60 days
    }
}));

// --- RATE LIMITER (auth endpoints only) ---
const authLimiter = rateLimit({
    windowMs:              15 * 60 * 1000,   // 15 minutes
    max:                   5,
    skipSuccessfulRequests: true,
    standardHeaders:       true,
    legacyHeaders:         false,
    message: { error: 'Too many attempts. Please try again in 15 minutes.' }
});

// --- HELPERS ---

/** Verify a Cloudflare Turnstile token server-side. */
function verifyTurnstile(token) {
    return new Promise((resolve) => {
        const body = JSON.stringify({
            secret:   process.env.TURNSTILE_SECRET_KEY,
            response: token
        });
        const req = https.request({
            hostname: 'challenges.cloudflare.com',
            path:     '/turnstile/v0/siteverify',
            method:   'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try   { resolve(JSON.parse(data).success === true); }
                catch { resolve(false); }
            });
        });
        req.on('error', () => resolve(false));
        req.write(body);
        req.end();
    });
}

/** 3–20 chars, alphanumeric + underscores only. */
function validateUsername(username) {
    return typeof username === 'string' && /^[a-zA-Z0-9_]{3,20}$/.test(username);
}

/** 12+ chars, must include uppercase, digit, and special character. */
function validatePassword(password) {
    if (typeof password !== 'string' || password.length < 12) return false;
    if (!/[A-Z]/.test(password))       return false;
    if (!/[0-9]/.test(password))       return false;
    if (!/[^a-zA-Z0-9]/.test(password)) return false;
    return true;
}

// --- WEBHOOK ---
// ⚠️ Raw body parser only for this route — required for HMAC signature verification
app.post('/git-webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
    console.log("Webhook received...");

    const secret    = process.env.WEBHOOK_SECRET;
    const signature = req.headers['x-hub-signature-256'];
    const hash      = `sha256=${crypto.createHmac('sha256', secret).update(req.body).digest('hex')}`;

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
        if (error)  { console.error(`execFile error: ${error}`); return; }
        if (stderr) { console.error(`stderr: ${stderr}`);        return; }
        console.log(`stdout: ${stdout}`);
    });

    res.status(200).send('Deployment started.');
});

// --- JSON BODY PARSER (for auth + reads routes) ---
app.use(express.json());

// --- DATABASE INIT ---
(async () => {
    db = await open({
        filename: process.env.DATABASE_PATH || './database/mcstories-db.sqlite',
        driver:   sqlite3.Database
    });

    // Performance pragmas
    await db.exec('PRAGMA journal_mode = WAL;');
    await db.exec('PRAGMA cache_size = -4000;');
    await db.exec('PRAGMA synchronous = NORMAL;');
    await db.exec('PRAGMA foreign_keys = ON;');

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

    // One-time FTS index population
    const ftsCount     = await db.get('SELECT COUNT(*) as count FROM stories_fts');
    const storiesCount = await db.get('SELECT COUNT(*) as count FROM stories');
    if (ftsCount.count < storiesCount.count) {
        console.log(`[DB] Building FTS index for ${storiesCount.count} stories (one-time, please wait)...`);
        await db.exec("INSERT INTO stories_fts(stories_fts) VALUES('rebuild');");
        console.log('[DB] FTS index built successfully.');
    }

    // Add marked_new_at column to stories if it doesn't exist yet (safe migration)
    const storyColumns  = await db.all("PRAGMA table_info(stories)");
    const hasMarkedNewAt = storyColumns.some(col => col.name === 'marked_new_at');
    if (!hasMarkedNewAt) {
        await db.exec("ALTER TABLE stories ADD COLUMN marked_new_at TEXT;");
        console.log('[DB] Added marked_new_at column to stories table.');
    }

    // Users table
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            username   TEXT    NOT NULL UNIQUE COLLATE NOCASE,
            password   TEXT    NOT NULL,
            created_at TEXT    DEFAULT (datetime('now'))
        );
    `);

    // User reads table
    await db.exec(`
        CREATE TABLE IF NOT EXISTS user_reads (
            user_id  INTEGER NOT NULL,
            story_id INTEGER NOT NULL,
            read_at  TEXT    DEFAULT (datetime('now')),
            PRIMARY KEY (user_id, story_id),
            FOREIGN KEY (user_id)  REFERENCES users(id)   ON DELETE CASCADE,
            FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
        );
    `);
    await db.exec('CREATE INDEX IF NOT EXISTS idx_user_reads ON user_reads(user_id);');

    console.log(`[DB] Connected. ${storiesCount.count.toLocaleString()} stories in database.`);
})();

// --- STATIC FILES — 7-day browser cache for fonts, CSS, JS ---
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '7d',
    etag:   true
}));

// --- AUTH PAGE ROUTES ---
app.get('/login',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));

// --- API: Auth — me ---
app.get('/api/auth/me', (req, res) => {
    if (req.session.userId) {
        res.json({ loggedIn: true, username: req.session.username });
    } else {
        res.json({ loggedIn: false });
    }
});

// --- API: Auth — register ---
app.post('/api/auth/register', authLimiter, async (req, res) => {
    try {
        const { username, password, turnstileToken } = req.body;

        if (!turnstileToken || !await verifyTurnstile(turnstileToken)) {
            return res.status(400).json({ error: 'Bot verification failed. Please try again.' });
        }
        if (!validateUsername(username)) {
            return res.status(400).json({ error: 'Username must be 3–20 characters and contain only letters, numbers, and underscores.' });
        }
        if (!validatePassword(password)) {
            return res.status(400).json({ error: 'Password must be at least 12 characters and include an uppercase letter, a number, and a special character.' });
        }

        const existing = await db.get('SELECT id FROM users WHERE username = ?', username);
        if (existing) {
            return res.status(409).json({ error: 'That username is already taken.' });
        }

        const hash   = await bcrypt.hash(password, 12);
        const result = await db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hash]);

        req.session.userId   = result.lastID;
        req.session.username = username;

        res.json({ success: true });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ error: 'Registration failed. Please try again.' });
    }
});

// --- API: Auth — login ---
app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
        const { username, password, turnstileToken } = req.body;

        if (!turnstileToken || !await verifyTurnstile(turnstileToken)) {
            return res.status(400).json({ error: 'Bot verification failed. Please try again.' });
        }

        const user = await db.get(
            'SELECT id, username, password FROM users WHERE username = ? COLLATE NOCASE',
            username
        );
        if (!user || !await bcrypt.compare(password, user.password)) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        req.session.userId   = user.id;
        req.session.username = user.username;

        res.json({ success: true });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

// --- API: Auth — logout ---
app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

// --- API: Reads — mark as read ---
app.post('/api/reads/:story_id', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const storyId = parseInt(req.params.story_id, 10);
    if (!storyId) return res.status(400).json({ error: 'Invalid story ID.' });
    try {
        await db.run(
            'INSERT OR IGNORE INTO user_reads (user_id, story_id) VALUES (?, ?)',
            [req.session.userId, storyId]
        );
        res.json({ success: true });
    } catch (error) {
        console.error('Mark read error:', error);
        res.status(500).json({ error: 'Failed to mark story as read.' });
    }
});

// --- API: Reads — unmark as read ---
app.delete('/api/reads/:story_id', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const storyId = parseInt(req.params.story_id, 10);
    if (!storyId) return res.status(400).json({ error: 'Invalid story ID.' });
    try {
        await db.run(
            'DELETE FROM user_reads WHERE user_id = ? AND story_id = ?',
            [req.session.userId, storyId]
        );
        res.json({ success: true });
    } catch (error) {
        console.error('Mark unread error:', error);
        res.status(500).json({ error: 'Failed to mark story as unread.' });
    }
});

// --- API: Total story count ---
app.get('/api/count', async (req, res) => {
    try {
        const result = await db.get('SELECT COUNT(*) as count FROM stories');
        res.json({ count: result.count });
    } catch (error) {
        console.error('Count API error:', error);
        res.status(500).json({ error: 'Failed to fetch story count.' });
    }
});

// --- API: Search with FTS, tag filtering, pagination, read status, and NEW badge ---
app.get('/api/search', async (req, res) => {
    try {
        const { query, categories, excludedCategories, page = 1, limit = 50 } = req.query;

        const pageNum  = Math.max(1, parseInt(page)  || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 50));
        const offset   = (pageNum - 1) * limitNum;

        const includeTags = categories          ? categories.split(',').map(t => t.trim().toLowerCase()).filter(Boolean)          : [];
        const excludeTags = excludedCategories  ? excludedCategories.split(',').map(t => t.trim().toLowerCase()).filter(Boolean)  : [];

        // Sanitise query for FTS5
        const rawQuery = (query || '').trim();
        const ftsQuery = rawQuery
            .replace(/[^\w\s]/g, ' ')
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map(w => `${w}*`)
            .join(' ');

        const usesFts = ftsQuery.length > 0;

        // -1 means "no user" — the LEFT JOIN ON ur.user_id = ? will never match, giving NULL → is_read = 0
        const userId = req.session.userId || -1;

        let sql, countSql;
        const params      = [];
        const countParams = [];
        const tagClauses  = [];

        includeTags.forEach(tag => tagClauses.push({ sql: 's.categories LIKE ?',     val: `%${tag}%` }));
        excludeTags.forEach(tag => tagClauses.push({ sql: 's.categories NOT LIKE ?', val: `%${tag}%` }));

        if (usesFts) {
            const tagAndClause = tagClauses.length > 0
                ? ' AND ' + tagClauses.map(c => c.sql).join(' AND ')
                : '';

            sql = `
                SELECT s.id, s.url, s.title, s.synopsis, s.categories,
                       CASE WHEN ur.story_id IS NOT NULL THEN 1 ELSE 0 END AS is_read,
                       CASE WHEN s.marked_new_at > datetime('now', '-60 days') THEN 1 ELSE 0 END AS is_new
                FROM stories s
                LEFT JOIN user_reads ur ON s.id = ur.story_id AND ur.user_id = ?
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
            params.push(userId, ftsQuery);
            countParams.push(ftsQuery);
            tagClauses.forEach(c => { params.push(c.val); countParams.push(c.val); });

        } else {
            const whereClause = tagClauses.length > 0
                ? ' WHERE ' + tagClauses.map(c => c.sql).join(' AND ')
                : '';

            sql = `
                SELECT s.id, s.url, s.title, s.synopsis, s.categories,
                       CASE WHEN ur.story_id IS NOT NULL THEN 1 ELSE 0 END AS is_read,
                       CASE WHEN s.marked_new_at > datetime('now', '-60 days') THEN 1 ELSE 0 END AS is_new
                FROM stories s
                LEFT JOIN user_reads ur ON s.id = ur.story_id AND ur.user_id = ?
                ${whereClause}
                ORDER BY s.title
                LIMIT ? OFFSET ?
            `;
            countSql = `SELECT COUNT(*) as total FROM stories s ${whereClause}`;
            params.push(userId);
            tagClauses.forEach(c => { params.push(c.val); countParams.push(c.val); });
        }

        params.push(limitNum, offset);

        const [stories, countResult] = await Promise.all([
            db.all(sql, params),
            db.get(countSql, countParams)
        ]);

        const formattedStories = stories.map(story => ({
            ...story,
            categories: story.categories ? story.categories.split(',') : [],
            is_read:    story.is_read === 1,
            is_new:     story.is_new  === 1
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

// --- SCHEDULED SCRAPER — runs as a forked child process ---
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
