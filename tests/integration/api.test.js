/**
 * Integration tests — Express API
 *
 * Run with: npm test
 *
 * Environment is configured BEFORE server.js is imported so the server
 * uses an isolated temp SQLite file and never touches the production DB.
 */
const path    = require('path');
const os      = require('os');
const fs      = require('fs');
const request = require('supertest');
const bcrypt  = require('bcrypt');

// ── Configure test environment (MUST happen before requiring server) ──────────
const testDbPath = path.join(os.tmpdir(), `mcstories-test-${process.pid}-${Date.now()}.sqlite`);
process.env.DATABASE_PATH  = testDbPath;
process.env.SESSION_SECRET = 'jest-test-secret-32-chars-long-xx';
process.env.NODE_ENV       = 'test';

// ── Import the server (no listen() side-effect in test mode) ─────────────────
const { app, dbReady, getDb } = require('../../server');

let db;

// ── Counter for unique usernames across tests ─────────────────────────────────
let _userSeq = 0;
function uid(prefix = 'user') {
    return `${prefix}${++_userSeq}`;
}

// Module-level admin agent (initialised in Admin API beforeAll, reused in Page routes)
let adminAgent;
let adminId;

// ── Helper: register + return an authenticated supertest agent ────────────────
async function registeredAgent(username, password = 'TestPass1!Secure') {
    const agent = request.agent(app);
    const res   = await agent
        .post('/api/auth/register')
        .send({ username, password, turnstileToken: 'bypass' });
    expect(res.status).toBe(200);
    return agent;
}

// ─────────────────────────────────────────────────────────────────────────────
beforeAll(async () => {
    await dbReady;
    db = getDb();

    // Seed one story so search/reads endpoints have data to work with.
    // The FTS triggers will index it automatically.
    await db.run(`
        INSERT OR IGNORE INTO stories (url, title, synopsis, categories)
        VALUES (
            'https://mcstories.com/TestStory/index.html',
            'The Test Story',
            'A synopsis for the integration test story.',
            'mc,mf'
        )
    `);
}, 30000);

afterAll(async () => {
    if (db) await db.close();
    // Remove temp files created by this test run
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(testDbPath + suffix); } catch { /* already gone */ }
    }
    try {
        const sessFile = path.join(__dirname, '../../database/sessions-test.db');
        fs.unlinkSync(sessFile);
    } catch { /* ok */ }
});

// ═════════════════════════════════════════════════════════════════════════════
// Auth — /api/auth/me
// ═════════════════════════════════════════════════════════════════════════════
describe('GET /api/auth/me', () => {
    test('returns loggedIn:false for unauthenticated requests', async () => {
        const res = await request(app).get('/api/auth/me');
        expect(res.status).toBe(200);
        expect(res.body.loggedIn).toBe(false);
    });

    test('returns loggedIn:true after registration', async () => {
        const agent = await registeredAgent(uid('me'));
        const res   = await agent.get('/api/auth/me');
        expect(res.body.loggedIn).toBe(true);
        expect(typeof res.body.username).toBe('string');
        expect(res.body.isAdmin).toBe(false);
    });

    test('returns theme field defaulting to "light" for new users', async () => {
        const agent = await registeredAgent(uid('meTheme'));
        const res   = await agent.get('/api/auth/me');
        expect(res.body.loggedIn).toBe(true);
        expect(res.body.theme).toBe('light');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Auth — Registration
// ═════════════════════════════════════════════════════════════════════════════
describe('POST /api/auth/register', () => {
    test('rejects username shorter than 3 chars', async () => {
        const res = await request(app)
            .post('/api/auth/register')
            .send({ username: 'ab', password: 'TestPass1!Secure', turnstileToken: 'bypass' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/3/);
    });

    test('rejects username longer than 20 chars', async () => {
        const res = await request(app)
            .post('/api/auth/register')
            .send({ username: 'a'.repeat(21), password: 'TestPass1!Secure', turnstileToken: 'bypass' });
        expect(res.status).toBe(400);
    });

    test('rejects username with invalid characters', async () => {
        const res = await request(app)
            .post('/api/auth/register')
            .send({ username: 'user@domain', password: 'TestPass1!Secure', turnstileToken: 'bypass' });
        expect(res.status).toBe(400);
    });

    test('rejects reserved username "admin" (any case)', async () => {
        for (const name of ['admin', 'Admin', 'ADMIN', 'aDmIn']) {
            const res = await request(app)
                .post('/api/auth/register')
                .send({ username: name, password: 'TestPass1!Secure', turnstileToken: 'bypass' });
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/reserved/);
        }
    });

    test('rejects a weak password (no uppercase)', async () => {
        const res = await request(app)
            .post('/api/auth/register')
            .send({ username: uid('reg'), password: 'nouppercase1!', turnstileToken: 'bypass' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/uppercase/);
    });

    test('rejects a weak password (too short)', async () => {
        const res = await request(app)
            .post('/api/auth/register')
            .send({ username: uid('reg'), password: 'Short1!', turnstileToken: 'bypass' });
        expect(res.status).toBe(400);
    });

    test('registers a new user successfully and establishes session', async () => {
        const agent = request.agent(app);
        const res   = await agent
            .post('/api/auth/register')
            .send({ username: uid('reg'), password: 'TestPass1!Secure', turnstileToken: 'bypass' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const me = await agent.get('/api/auth/me');
        expect(me.body.loggedIn).toBe(true);
    });

    test('rejects duplicate username (exact match)', async () => {
        const name = uid('dup');
        await request(app)
            .post('/api/auth/register')
            .send({ username: name, password: 'TestPass1!Secure', turnstileToken: 'bypass' });

        const res = await request(app)
            .post('/api/auth/register')
            .send({ username: name, password: 'TestPass1!Secure', turnstileToken: 'bypass' });
        expect(res.status).toBe(409);
    });

    test('rejects duplicate username (case-insensitive)', async () => {
        const name = uid('CASE');
        await request(app)
            .post('/api/auth/register')
            .send({ username: name.toLowerCase(), password: 'TestPass1!Secure', turnstileToken: 'bypass' });

        const res = await request(app)
            .post('/api/auth/register')
            .send({ username: name.toUpperCase(), password: 'TestPass1!Secure', turnstileToken: 'bypass' });
        expect(res.status).toBe(409);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Auth — Login
// ═════════════════════════════════════════════════════════════════════════════
describe('POST /api/auth/login', () => {
    const loginUser = uid('login');
    const loginPass = 'LoginPass1!Secure';

    beforeAll(async () => {
        await request(app)
            .post('/api/auth/register')
            .send({ username: loginUser, password: loginPass, turnstileToken: 'bypass' });
    });

    test('logs in with correct credentials', async () => {
        const agent = request.agent(app);
        const res   = await agent
            .post('/api/auth/login')
            .send({ username: loginUser, password: loginPass, turnstileToken: 'bypass' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const me = await agent.get('/api/auth/me');
        expect(me.body.loggedIn).toBe(true);
        expect(me.body.username).toBe(loginUser);
    });

    test('rejects wrong password', async () => {
        const res = await request(app)
            .post('/api/auth/login')
            .send({ username: loginUser, password: 'WrongPass1!', turnstileToken: 'bypass' });
        expect(res.status).toBe(401);
        expect(res.body.error).toBeTruthy();
    });

    test('rejects non-existent user', async () => {
        const res = await request(app)
            .post('/api/auth/login')
            .send({ username: 'ghost_nobody', password: 'TestPass1!Secure', turnstileToken: 'bypass' });
        expect(res.status).toBe(401);
    });

    test('rejects suspended user', async () => {
        const suspUser = uid('susp');
        const suspPass = 'SuspendPass1!';

        // Register via the test helper
        await request(app)
            .post('/api/auth/register')
            .send({ username: suspUser, password: suspPass, turnstileToken: 'bypass' });

        // Suspend directly in DB
        await db.run("UPDATE users SET is_suspended = 1 WHERE username = ?", suspUser);

        const res = await request(app)
            .post('/api/auth/login')
            .send({ username: suspUser, password: suspPass, turnstileToken: 'bypass' });
        expect(res.status).toBe(403);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Auth — Logout
// ═════════════════════════════════════════════════════════════════════════════
describe('POST /api/auth/logout', () => {
    test('destroys the session so subsequent /me returns loggedIn:false', async () => {
        const agent = await registeredAgent(uid('logout'));
        await agent.post('/api/auth/logout');
        const me = await agent.get('/api/auth/me');
        expect(me.body.loggedIn).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Preferences
// ═════════════════════════════════════════════════════════════════════════════
describe('POST /api/preferences', () => {
    test('returns 401 for unauthenticated requests', async () => {
        const res = await request(app)
            .post('/api/preferences')
            .send({ theme: 'dark' });
        expect(res.status).toBe(401);
    });

    test('rejects an invalid theme value', async () => {
        const agent = await registeredAgent(uid('prefBad'));
        const res   = await agent.post('/api/preferences').send({ theme: 'blue' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBeTruthy();
    });

    test('rejects missing theme field', async () => {
        const agent = await registeredAgent(uid('prefMiss'));
        const res   = await agent.post('/api/preferences').send({});
        expect(res.status).toBe(400);
    });

    test('saves theme "dark" and reflects in /api/auth/me', async () => {
        const agent = await registeredAgent(uid('prefDark'));

        const save = await agent.post('/api/preferences').send({ theme: 'dark' });
        expect(save.status).toBe(200);
        expect(save.body.success).toBe(true);

        const me = await agent.get('/api/auth/me');
        expect(me.body.theme).toBe('dark');
    });

    test('saves theme "light" and reflects in /api/auth/me', async () => {
        const agent = await registeredAgent(uid('prefLight'));

        // Set dark first, then switch back to light
        await agent.post('/api/preferences').send({ theme: 'dark' });
        const save = await agent.post('/api/preferences').send({ theme: 'light' });
        expect(save.status).toBe(200);

        const me = await agent.get('/api/auth/me');
        expect(me.body.theme).toBe('light');
    });

    test('persisted theme survives logout and re-login (cross-session sync)', async () => {
        const username = uid('prefSync');
        const password = 'SyncPass1!Secure';

        // Register and set dark theme
        const agent1 = request.agent(app);
        await agent1.post('/api/auth/register').send({ username, password, turnstileToken: 'bypass' });
        await agent1.post('/api/preferences').send({ theme: 'dark' });
        await agent1.post('/api/auth/logout');

        // Fresh session — theme should still be dark
        const agent2 = request.agent(app);
        await agent2.post('/api/auth/login').send({ username, password, turnstileToken: 'bypass' });
        const me = await agent2.get('/api/auth/me');
        expect(me.body.theme).toBe('dark');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Search
// ═════════════════════════════════════════════════════════════════════════════
describe('GET /api/search', () => {
    test('returns correct response shape', async () => {
        const res = await request(app).get('/api/search');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.stories)).toBe(true);
        expect(typeof res.body.total).toBe('number');
        expect(typeof res.body.page).toBe('number');
        expect(typeof res.body.totalPages).toBe('number');
    });

    test('returns is_read:false for guest users', async () => {
        const res = await request(app).get('/api/search');
        expect(res.body.stories.every(s => s.is_read === false)).toBe(true);
    });

    test('story categories are returned as arrays', async () => {
        const res = await request(app).get('/api/search');
        expect(res.body.stories.every(s => Array.isArray(s.categories))).toBe(true);
    });

    test('filters by included category', async () => {
        const res = await request(app).get('/api/search?categories=mc');
        expect(res.status).toBe(200);
        expect(res.body.total).toBeGreaterThanOrEqual(1);
        // Every returned story must include the 'mc' tag
        res.body.stories.forEach(s => {
            expect(s.categories).toContain('mc');
        });
    });

    test('full-text search finds the seeded story', async () => {
        const res = await request(app).get('/api/search?query=integration+test+story');
        expect(res.status).toBe(200);
        expect(res.body.total).toBeGreaterThanOrEqual(1);
    });

    test('respects limit parameter', async () => {
        const res = await request(app).get('/api/search?limit=1');
        expect(res.body.stories.length).toBeLessThanOrEqual(1);
        expect(res.body.limit).toBe(1);
    });

    test('clamps limit at 100', async () => {
        const res = await request(app).get('/api/search?limit=9999');
        expect(res.body.limit).toBe(100);
    });

    test('returns empty array when no match', async () => {
        const res = await request(app).get('/api/search?query=zzzzzzzzzzzzzzz_no_match');
        expect(res.status).toBe(200);
        expect(res.body.stories).toHaveLength(0);
        expect(res.body.total).toBe(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Random story
// ═════════════════════════════════════════════════════════════════════════════
describe('GET /api/random', () => {
    test('returns a single story with expected shape', async () => {
        const res = await request(app).get('/api/random');
        expect(res.status).toBe(200);
        expect(res.body.story).not.toBeNull();
        const s = res.body.story;
        expect(typeof s.id).toBe('number');
        expect(typeof s.title).toBe('string');
        expect(typeof s.url).toBe('string');
        expect(Array.isArray(s.categories)).toBe(true);
        expect(typeof s.is_read).toBe('boolean');
        expect(typeof s.is_new).toBe('boolean');
    });

    test('returns is_read:false for guest users', async () => {
        const res = await request(app).get('/api/random');
        expect(res.body.story.is_read).toBe(false);
    });

    test('respects included category filter', async () => {
        const res = await request(app).get('/api/random?categories=mc');
        expect(res.status).toBe(200);
        // seeded story has mc,mf — should always return something
        if (res.body.story) {
            expect(res.body.story.categories).toContain('mc');
        }
    });

    test('falls back to exclude-only when include tags find no match', async () => {
        // 'bd' not present in the seeded story; fallback (no include, no exclude) returns the seeded story
        const res = await request(app).get('/api/random?categories=bd');
        expect(res.status).toBe(200);
        expect(res.body.fallback).toBe(true);
        expect(res.body.story).not.toBeNull();
        expect(res.body.story.categories).not.toContain('bd');
    });

    test('returns null when exclude-only fallback also finds nothing', async () => {
        // Excluding mc removes the only seeded story, so both passes return nothing
        const res = await request(app).get('/api/random?categories=bd&excludedCategories=mc');
        expect(res.status).toBe(200);
        expect(res.body.story).toBeNull();
        expect(res.body.fallback).toBe(false);
    });

    test('reflects is_read:true for logged-in user who read the story', async () => {
        const agent = await registeredAgent(uid('randRead'));
        const searchRes = await agent.get('/api/search?query=integration+test+story');
        const story     = searchRes.body.stories[0];
        await agent.post(`/api/reads/${story.id}`);

        // Random with mc filter — seeded story is the only mc story, so it must be returned
        const res = await agent.get('/api/random?categories=mc');
        expect(res.status).toBe(200);
        if (res.body.story && res.body.story.id === story.id) {
            expect(res.body.story.is_read).toBe(true);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Story count
// ═════════════════════════════════════════════════════════════════════════════
describe('GET /api/count', () => {
    test('returns a numeric count ≥ 1 (seeded story exists)', async () => {
        const res = await request(app).get('/api/count');
        expect(res.status).toBe(200);
        expect(typeof res.body.count).toBe('number');
        expect(res.body.count).toBeGreaterThanOrEqual(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Reads
// ═════════════════════════════════════════════════════════════════════════════
describe('POST /api/reads/:story_id  &  DELETE /api/reads/:story_id', () => {
    test('returns 401 for unauthenticated POST', async () => {
        const res = await request(app).post('/api/reads/1');
        expect(res.status).toBe(401);
    });

    test('returns 401 for unauthenticated DELETE', async () => {
        const res = await request(app).delete('/api/reads/1');
        expect(res.status).toBe(401);
    });

    test('marks a story as read and reflects in search results', async () => {
        const agent = await registeredAgent(uid('reads'));

        // Get the ID of the seeded story
        const searchRes = await agent.get('/api/search?query=integration+test+story');
        const story     = searchRes.body.stories[0];
        expect(story).toBeTruthy();

        // Mark as read
        const markRes = await agent.post(`/api/reads/${story.id}`);
        expect(markRes.status).toBe(200);

        // Verify is_read is true in subsequent search
        const afterRes = await agent.get(`/api/search?query=integration+test+story`);
        const updated  = afterRes.body.stories.find(s => s.id === story.id);
        expect(updated.is_read).toBe(true);
    });

    test('marks a story as unread (DELETE) and reflects in search results', async () => {
        const agent = await registeredAgent(uid('unread'));

        const searchRes = await agent.get('/api/search?query=integration+test+story');
        const story     = searchRes.body.stories[0];

        // Mark read, then unread
        await agent.post(`/api/reads/${story.id}`);
        const delRes = await agent.delete(`/api/reads/${story.id}`);
        expect(delRes.status).toBe(200);

        const afterRes = await agent.get(`/api/search?query=integration+test+story`);
        const updated  = afterRes.body.stories.find(s => s.id === story.id);
        expect(updated.is_read).toBe(false);
    });

    test('ignores invalid (non-numeric) story IDs gracefully', async () => {
        const agent = await registeredAgent(uid('badid'));
        const res   = await agent.post('/api/reads/notanumber');
        expect(res.status).toBe(400);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Admin API
// ═════════════════════════════════════════════════════════════════════════════
describe('Admin API', () => {

    beforeAll(async () => {
        // Create an admin directly in DB (bypass the normal register flow)
        const hash   = await bcrypt.hash('AdminPass1!Secure', 12);
        const result = await db.run(
            "INSERT OR IGNORE INTO users (username, password, is_admin) VALUES ('testadmin_int', ?, 1)",
            hash
        );
        // If already exists (e.g. test re-run), fetch it
        const row = await db.get("SELECT id FROM users WHERE username = 'testadmin_int'");
        adminId = row.id;

        adminAgent = request.agent(app);
        await adminAgent.post('/api/auth/login').send({
            username: 'testadmin_int',
            password: 'AdminPass1!Secure',
            turnstileToken: 'bypass'
        });
    }, 20000);

    // --- Access control ---
    test('GET /api/admin/users — 401 for unauthenticated', async () => {
        const res = await request(app).get('/api/admin/users');
        expect(res.status).toBe(401);
    });

    test('GET /api/admin/users — 403 for non-admin', async () => {
        const agent = await registeredAgent(uid('nadm'));
        const res   = await agent.get('/api/admin/users');
        expect(res.status).toBe(403);
    });

    test('GET /api/admin/users — admin can list all users', async () => {
        const res = await adminAgent.get('/api/admin/users');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.users)).toBe(true);
        expect(res.body.users.length).toBeGreaterThanOrEqual(1);
    });

    // --- Create user ---
    test('POST /api/admin/users — creates a new user', async () => {
        const res = await adminAgent.post('/api/admin/users').send({
            username: uid('admcrt'),
            password: 'AdminCreate1!'
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    test('POST /api/admin/users — rejects invalid username', async () => {
        const res = await adminAgent.post('/api/admin/users').send({
            username: 'x!',
            password: 'AdminCreate1!'
        });
        expect(res.status).toBe(400);
    });

    test('POST /api/admin/users — rejects weak password', async () => {
        const res = await adminAgent.post('/api/admin/users').send({
            username: uid('admwk'),
            password: 'weak'
        });
        expect(res.status).toBe(400);
    });

    // --- Delete user ---
    test('DELETE /api/admin/users/:id — deletes a user', async () => {
        // Create user to delete
        const name = uid('admDel');
        await adminAgent.post('/api/admin/users').send({ username: name, password: 'DeleteMe1!Secure' });
        const usersRes = await adminAgent.get('/api/admin/users');
        const target   = usersRes.body.users.find(u => u.username === name);

        const res = await adminAgent.delete(`/api/admin/users/${target.id}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        // Verify gone
        const after = await adminAgent.get('/api/admin/users');
        expect(after.body.users.find(u => u.id === target.id)).toBeUndefined();
    });

    test('DELETE /api/admin/users/:id — cannot delete own account', async () => {
        const res = await adminAgent.delete(`/api/admin/users/${adminId}`);
        expect(res.status).toBe(400);
    });

    // --- Suspend / unsuspend ---
    test('POST /api/admin/users/:id/suspend — suspends a user', async () => {
        const name = uid('admSusp');
        await adminAgent.post('/api/admin/users').send({ username: name, password: 'SuspendMe1!Secure' });
        const usersRes = await adminAgent.get('/api/admin/users');
        const target   = usersRes.body.users.find(u => u.username === name);

        const res = await adminAgent.post(`/api/admin/users/${target.id}/suspend`).send({ suspended: true });
        expect(res.status).toBe(200);

        // Suspended user should get 403 on login
        const loginRes = await request(app)
            .post('/api/auth/login')
            .send({ username: name, password: 'SuspendMe1!Secure', turnstileToken: 'bypass' });
        expect(loginRes.status).toBe(403);
    });

    test('POST /api/admin/users/:id/suspend — cannot suspend own account', async () => {
        const res = await adminAgent.post(`/api/admin/users/${adminId}/suspend`).send({ suspended: true });
        expect(res.status).toBe(400);
    });

    // --- Reset password ---
    test('POST /api/admin/users/:id/reset-password — changes password', async () => {
        const name    = uid('admRst');
        const oldPass = 'OldPass1!Secure';
        const newPass = 'NewPass2@Secure';

        await adminAgent.post('/api/admin/users').send({ username: name, password: oldPass });
        const usersRes = await adminAgent.get('/api/admin/users');
        const target   = usersRes.body.users.find(u => u.username === name);

        const res = await adminAgent
            .post(`/api/admin/users/${target.id}/reset-password`)
            .send({ newPassword: newPass });
        expect(res.status).toBe(200);

        // Old password should no longer work
        const oldLogin = await request(app)
            .post('/api/auth/login')
            .send({ username: name, password: oldPass, turnstileToken: 'bypass' });
        expect(oldLogin.status).toBe(401);

        // New password should work
        const newLogin = await request(app)
            .post('/api/auth/login')
            .send({ username: name, password: newPass, turnstileToken: 'bypass' });
        expect(newLogin.status).toBe(200);
    });

    test('POST /api/admin/users/:id/reset-password — rejects weak new password', async () => {
        const name = uid('admRstWk');
        await adminAgent.post('/api/admin/users').send({ username: name, password: 'OldPass1!Secure' });
        const usersRes = await adminAgent.get('/api/admin/users');
        const target   = usersRes.body.users.find(u => u.username === name);

        const res = await adminAgent
            .post(`/api/admin/users/${target.id}/reset-password`)
            .send({ newPassword: 'weak' });
        expect(res.status).toBe(400);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Static / page routes
// ═════════════════════════════════════════════════════════════════════════════
describe('Page routes', () => {
    test('GET / serves index.html (200)', async () => {
        const res = await request(app).get('/');
        expect(res.status).toBe(200);
    });

    test('GET /login serves login.html (200)', async () => {
        const res = await request(app).get('/login');
        expect(res.status).toBe(200);
    });

    test('GET /register serves register.html (200)', async () => {
        const res = await request(app).get('/register');
        expect(res.status).toBe(200);
    });

    test('GET /admin redirects unauthenticated user to /login', async () => {
        const res = await request(app).get('/admin').redirects(0);
        expect(res.status).toBe(302);
        expect(res.headers.location).toMatch(/\/login/);
    });

    test('GET /admin redirects non-admin to /', async () => {
        const agent = await registeredAgent(uid('admPage'));
        const res   = await agent.get('/admin').redirects(0);
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/');
    });

    test('GET /admin serves admin page for admin users', async () => {
        // adminAgent is set in the Admin API beforeAll (same module scope)
        expect(adminAgent).toBeTruthy();
        const res = await adminAgent.get('/admin');
        expect(res.status).toBe(200);
    });
});
