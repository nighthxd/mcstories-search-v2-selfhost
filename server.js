// server.js
require('dotenv').config();
const express     = require('express');
const crypto      = require('crypto');
const https       = require('https');
const { execFile, fork } = require('child_process');
const bodyParser  = require('body-parser');
const compression = require('compression');
const path        = require('path');
const cron        = require('node-cron');
const { open }    = require('sqlite');
const sqlite3     = require('sqlite3');
const bcrypt      = require('bcrypt');
const session     = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const rateLimit   = require('express-rate-limit');
const { validateUsername, validatePassword } = require('./lib/validators');

const app  = express();
const PORT = process.env.PORT || 3000;
let db;

// --- TRUST PROXY (required for Nginx + secure cookies + real IP for rate limiting) ---
app.set('trust proxy', 1);

// --- MIDDLEWARE ---
app.use(compression());

// --- SESSION ---
// In test mode, use a separate sessions file so tests never corrupt production data.
const _sessionDb  = process.env.NODE_ENV === 'test' ? 'sessions-test.db' : 'sessions.db';
const _sessionDir = path.join(__dirname, 'database');
app.use(session({
    store: new SQLiteStore({ db: _sessionDb, dir: _sessionDir }),
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
// Bypassed in test mode so integration tests can send multiple auth requests
// without hitting the 5-attempt window.
const authLimiter = process.env.NODE_ENV === 'test'
    ? (req, res, next) => next()
    : rateLimit({
          windowMs:              15 * 60 * 1000,
          max:                   5,
          skipSuccessfulRequests: true,
          standardHeaders:       true,
          legacyHeaders:         false,
          message: { error: 'Too many attempts. Please try again in 15 minutes.' }
      });

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/** Cloudflare Turnstile server-side verification. */
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

/** Express middleware — rejects non-admin requests with 401/403. */
async function requireAdmin(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    try {
        const user = await db.get('SELECT is_admin FROM users WHERE id = ?', req.session.userId);
        if (!user || !user.is_admin) return res.status(403).json({ error: 'Access denied.' });
        next();
    } catch (err) {
        console.error('requireAdmin error:', err);
        res.status(500).json({ error: 'Server error.' });
    }
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
// ⚠️ Raw body parser only for this route — required for HMAC signature verification
app.post('/git-webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
    console.log("Webhook received...");

    const secret    = process.env.WEBHOOK_SECRET;
    const signature = req.headers['x-hub-signature-256'];
    const hash      = `sha256=${crypto.createHmac('sha256', secret).update(req.body).digest('hex')}`;

    // Use timingSafeEqual to prevent timing-based secret leakage
    const sigBuf  = Buffer.from(signature || '');
    const hashBuf = Buffer.from(hash);
    const valid   = sigBuf.length === hashBuf.length && crypto.timingSafeEqual(sigBuf, hashBuf);
    if (!valid) {
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

// --- JSON BODY PARSER (for auth, admin, and reads routes) ---
app.use(express.json());

// ─── DATABASE INIT ────────────────────────────────────────────────────────────
// dbReady is a promise that resolves once the DB is fully initialised.
// Tests can `await dbReady` before sending requests.
const dbReady = (async () => {
    db = await open({
        filename: process.env.DATABASE_PATH || './database/mcstories-db.sqlite',
        driver:   sqlite3.Database
    });

    // Performance pragmas
    await db.exec('PRAGMA journal_mode = WAL;');
    await db.exec('PRAGMA cache_size = -4000;');
    await db.exec('PRAGMA synchronous = NORMAL;');
    await db.exec('PRAGMA foreign_keys = ON;');

    // ── scrape_state table ────────────────────────────────────────────────────
    await db.exec(`
        CREATE TABLE IF NOT EXISTS scrape_state (
            id                          INTEGER PRIMARY KEY,
            last_scraped_category_index INTEGER
        );
    `);
    // Seed the initial row if it doesn't exist (scraper needs it)
    await db.run(`INSERT OR IGNORE INTO scrape_state (id, last_scraped_category_index) VALUES (1, -1);`);

    // ── stories table (created here for fresh DBs; columns may have been
    //    added incrementally via ALTER TABLE in later migrations below) ──────────
    await db.exec(`
        CREATE TABLE IF NOT EXISTS stories (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            title           TEXT    NOT NULL,
            url             TEXT    UNIQUE NOT NULL,
            categories      TEXT,
            last_scraped_at TEXT    DEFAULT (datetime('now')),
            synopsis        TEXT,
            marked_new_at   TEXT,
            last_seen_at    TEXT
        );
    `);

    // Index on categories for faster tag filtering
    await db.exec('CREATE INDEX IF NOT EXISTS idx_categories ON stories(categories);');

    // FTS5 virtual table
    await db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS stories_fts
        USING fts5(title, synopsis, content='stories', content_rowid='id');
    `);
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

    // One-time FTS population
    const ftsCount     = await db.get('SELECT COUNT(*) as count FROM stories_fts');
    const storiesCount = await db.get('SELECT COUNT(*) as count FROM stories');
    if (ftsCount.count < storiesCount.count) {
        console.log(`[DB] Building FTS index for ${storiesCount.count} stories (one-time, please wait)...`);
        await db.exec("INSERT INTO stories_fts(stories_fts) VALUES('rebuild');");
        console.log('[DB] FTS index built successfully.');
    }

    // ── stories column migrations (safe) ──
    const storyColumns  = await db.all("PRAGMA table_info(stories)");
    const storyColNames = storyColumns.map(c => c.name);
    if (!storyColNames.includes('marked_new_at')) {
        await db.exec("ALTER TABLE stories ADD COLUMN marked_new_at TEXT;");
        console.log('[DB] Added marked_new_at column to stories table.');
    }
    if (!storyColNames.includes('last_seen_at')) {
        await db.exec("ALTER TABLE stories ADD COLUMN last_seen_at TEXT;");
        console.log('[DB] Added last_seen_at column to stories table.');
    }

    // ── users table ──
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            username     TEXT    NOT NULL UNIQUE COLLATE NOCASE,
            password     TEXT    NOT NULL,
            is_admin     INTEGER NOT NULL DEFAULT 0,
            is_suspended INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT    DEFAULT (datetime('now'))
        );
    `);

    // Safe migrations for columns added after initial deploy
    const userColumns   = await db.all("PRAGMA table_info(users)");
    const userColNames  = userColumns.map(c => c.name);
    if (!userColNames.includes('is_admin')) {
        await db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;");
        console.log('[DB] Added is_admin column to users table.');
    }
    if (!userColNames.includes('is_suspended')) {
        await db.exec("ALTER TABLE users ADD COLUMN is_suspended INTEGER NOT NULL DEFAULT 0;");
        console.log('[DB] Added is_suspended column to users table.');
    }

    // Grant admin flag to the 'admin' account (idempotent)
    const adminGrant = await db.run(
        "UPDATE users SET is_admin = 1 WHERE username = 'admin' COLLATE NOCASE"
    );
    if (adminGrant.changes > 0) {
        console.log('[DB] Granted admin privileges to "admin" account.');
    }

    // ── user_reads table ──
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
})();  // dbReady

// ─── STATIC FILES — 7-day browser cache ──────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '7d',
    etag:   true
}));

// ─── PAGE ROUTES ──────────────────────────────────────────────────────────────
app.get('/login',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));

// Admin page — server-side auth check; redirect if not logged in or not admin
app.get('/admin', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    try {
        const user = await db.get('SELECT is_admin FROM users WHERE id = ?', req.session.userId);
        if (!user || !user.is_admin) return res.redirect('/');
        res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    } catch {
        res.redirect('/');
    }
});

// ─── API: AUTH ────────────────────────────────────────────────────────────────

// GET /api/auth/me — also checks for suspension, auto-destroys session if suspended/deleted
app.get('/api/auth/me', async (req, res) => {
    if (!req.session.userId) return res.json({ loggedIn: false });
    try {
        const user = await db.get(
            'SELECT username, is_admin, is_suspended FROM users WHERE id = ?',
            req.session.userId
        );
        if (!user || user.is_suspended) {
            req.session.destroy();
            return res.json({ loggedIn: false });
        }
        res.json({ loggedIn: true, username: user.username, isAdmin: user.is_admin === 1 });
    } catch {
        res.json({ loggedIn: false });
    }
});

// POST /api/auth/register
app.post('/api/auth/register', authLimiter, async (req, res) => {
    try {
        const { username, password, turnstileToken } = req.body;

        // Turnstile is bypassed in test mode so integration tests don't need a real token.
        if (process.env.NODE_ENV !== 'test') {
            if (!turnstileToken || !await verifyTurnstile(turnstileToken)) {
                return res.status(400).json({ error: 'Bot verification failed. Please try again.' });
            }
        }
        if (!validateUsername(username)) {
            return res.status(400).json({ error: 'Username must be 3–20 characters and contain only letters, numbers, and underscores.' });
        }
        if (!validatePassword(password)) {
            return res.status(400).json({ error: 'Password must be at least 12 characters and include an uppercase letter, a number, and a special character.' });
        }

        const existing = await db.get('SELECT id FROM users WHERE username = ?', username);
        if (existing) return res.status(409).json({ error: 'That username is already taken.' });

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

// POST /api/auth/login
app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
        const { username, password, turnstileToken } = req.body;

        if (process.env.NODE_ENV !== 'test') {
            if (!turnstileToken || !await verifyTurnstile(turnstileToken)) {
                return res.status(400).json({ error: 'Bot verification failed. Please try again.' });
            }
        }

        const user = await db.get(
            'SELECT id, username, password, is_suspended FROM users WHERE username = ? COLLATE NOCASE',
            username
        );
        if (!user || !await bcrypt.compare(password, user.password)) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }
        if (user.is_suspended) {
            return res.status(403).json({ error: 'Your account has been suspended. Please contact the administrator.' });
        }

        req.session.userId   = user.id;
        req.session.username = user.username;
        res.json({ success: true });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

// ─── API: ADMIN ───────────────────────────────────────────────────────────────

// GET /api/admin/users — list all users with read counts
app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const users = await db.all(`
            SELECT u.id, u.username, u.created_at, u.is_admin, u.is_suspended,
                   COUNT(ur.story_id) AS read_count
            FROM users u
            LEFT JOIN user_reads ur ON u.id = ur.user_id
            GROUP BY u.id
            ORDER BY u.created_at ASC
        `);
        res.json({ users });
    } catch (error) {
        console.error('Admin list users error:', error);
        res.status(500).json({ error: 'Failed to fetch users.' });
    }
});

// POST /api/admin/users — create a user (no Turnstile needed — admin is authenticated)
app.post('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!validateUsername(username)) {
            return res.status(400).json({ error: 'Username must be 3–20 characters and contain only letters, numbers, and underscores.' });
        }
        if (!validatePassword(password)) {
            return res.status(400).json({ error: 'Password must be at least 12 characters and include an uppercase letter, a number, and a special character.' });
        }
        const existing = await db.get('SELECT id FROM users WHERE username = ?', username);
        if (existing) return res.status(409).json({ error: 'That username is already taken.' });

        const hash = await bcrypt.hash(password, 12);
        await db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hash]);
        res.json({ success: true });
    } catch (error) {
        console.error('Admin create user error:', error);
        res.status(500).json({ error: 'Failed to create user.' });
    }
});

// DELETE /api/admin/users/:id — delete user + cascade user_reads via FK
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
    const targetId = parseInt(req.params.id, 10);
    if (!targetId) return res.status(400).json({ error: 'Invalid user ID.' });
    if (targetId === req.session.userId) {
        return res.status(400).json({ error: 'You cannot delete your own account.' });
    }
    try {
        const result = await db.run('DELETE FROM users WHERE id = ?', targetId);
        if (result.changes === 0) return res.status(404).json({ error: 'User not found.' });
        res.json({ success: true });
    } catch (error) {
        console.error('Admin delete user error:', error);
        res.status(500).json({ error: 'Failed to delete user.' });
    }
});

// POST /api/admin/users/:id/suspend — suspend or unsuspend
app.post('/api/admin/users/:id/suspend', requireAdmin, async (req, res) => {
    const targetId = parseInt(req.params.id, 10);
    if (!targetId) return res.status(400).json({ error: 'Invalid user ID.' });
    if (targetId === req.session.userId) {
        return res.status(400).json({ error: 'You cannot suspend your own account.' });
    }
    const { suspended } = req.body;
    try {
        await db.run('UPDATE users SET is_suspended = ? WHERE id = ?', [suspended ? 1 : 0, targetId]);
        res.json({ success: true });
    } catch (error) {
        console.error('Admin suspend error:', error);
        res.status(500).json({ error: 'Failed to update user.' });
    }
});

// POST /api/admin/users/:id/reset-password
app.post('/api/admin/users/:id/reset-password', requireAdmin, async (req, res) => {
    const targetId = parseInt(req.params.id, 10);
    if (!targetId) return res.status(400).json({ error: 'Invalid user ID.' });
    const { newPassword } = req.body;
    if (!validatePassword(newPassword)) {
        return res.status(400).json({ error: 'Password must be at least 12 characters and include an uppercase letter, a number, and a special character.' });
    }
    try {
        const hash = await bcrypt.hash(newPassword, 12);
        await db.run('UPDATE users SET password = ? WHERE id = ?', [hash, targetId]);
        res.json({ success: true });
    } catch (error) {
        console.error('Admin reset password error:', error);
        res.status(500).json({ error: 'Failed to reset password.' });
    }
});

// ─── API: READS ───────────────────────────────────────────────────────────────

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

// ─── API: COUNT ───────────────────────────────────────────────────────────────
app.get('/api/count', async (req, res) => {
    try {
        const result = await db.get('SELECT COUNT(*) as count FROM stories');
        res.json({ count: result.count });
    } catch (error) {
        console.error('Count API error:', error);
        res.status(500).json({ error: 'Failed to fetch story count.' });
    }
});

// ─── API: SEARCH ──────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
    try {
        const { query, categories, excludedCategories, page = 1, limit = 50 } = req.query;

        const pageNum  = Math.max(1, parseInt(page)  || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 50));
        const offset   = (pageNum - 1) * limitNum;

        const includeTags = categories         ? categories.split(',').map(t => t.trim().toLowerCase()).filter(Boolean)         : [];
        const excludeTags = excludedCategories ? excludedCategories.split(',').map(t => t.trim().toLowerCase()).filter(Boolean) : [];

        const rawQuery = (query || '').trim();
        const ftsQuery = rawQuery
            .replace(/[^\w\s]/g, ' ')
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map(w => `${w}*`)
            .join(' ');

        const usesFts = ftsQuery.length > 0;

        // -1 → never matches ur.user_id, so is_read is always 0 for guests
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

// ─── SCHEDULED SCRAPER (disabled in test mode) ───────────────────────────────
if (process.env.NODE_ENV !== 'test') {
    const schedule = process.env.SCRAPE_SCHEDULE || '0 * * * *';
    console.log(`[Cron] Scraper scheduled: "${schedule}"`);
    cron.schedule(schedule, () => {
        console.log('[Cron] Triggered: forking scraper process...');
        const child = fork(path.join(__dirname, 'scrapers/scraper-worker.js'));
        child.on('exit', code => {
            if (code !== 0) console.error(`[Cron] Scraper process exited with code ${code}`);
            else            console.log('[Cron] Scraper process finished successfully.');
        });
    });
}

// Start HTTP server only when run directly (not when required by tests).
// Default bind to 127.0.0.1 so Nginx is the only public entry point.
// Override via HOST env var if needed (e.g. HOST=0.0.0.0 for Docker).
if (require.main === module) {
    const HOST = process.env.HOST || '127.0.0.1';
    app.listen(PORT, HOST, () => {
        console.log(`Server is running at http://${HOST}:${PORT}`);
    });
}

module.exports = { app, dbReady, getDb: () => db };
