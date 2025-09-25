// server.js
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { execFile } = require('child_process');
const bodyParser = require('body-parser'); // <-- Add this line
const path = require('path');
const cron = require('node-cron');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { runScraper } = require('./scrapers/scheduled-scraper');

const app = express();
const PORT = process.env.PORT || 3000;
let db;

// --- MIDDLEWARE ---
// Place this before your other app.use and app.get calls

// ⚠️ IMPORTANT: Use body-parser but only for the webhook route
// We need the raw body to verify the signature
app.post('/git-webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
    console.log("Webhook received...");

    // 1. Verify the signature
    const secret = process.env.WEBHOOK_SECRET;
    const signature = req.headers['x-hub-signature-256'];
    const hash = `sha256=${crypto.createHmac('sha256', secret).update(req.body).digest('hex')}`;

    if (signature !== hash) {
        console.error("Webhook signature verification failed!");
        return res.status(401).send('Signature mismatch');
    }

    // 2. Check if it's a push to the main branch
    const data = JSON.parse(req.body);
    if (data.ref !== 'refs/heads/main') {
        console.log("Push was not to main branch, ignoring.");
        return res.status(200).send('Push was not to main, ignored.');
    }

    // 3. Run the deployment script
    console.log("Signature verified. Running deployment script...");
    execFile('../deploy.sh', (error, stdout, stderr) => {
        if (error) {
            console.error(`execFile error: ${error}`);
            return;
        }
        if (stderr) {
            console.error(`stderr: ${stderr}`);
            return;
        }
        console.log(`stdout: ${stdout}`);
    });

    res.status(200).send('Deployment started.');
});

(async () => {
    db = await open({
        filename: process.env.DATABASE_PATH || './database/mcstories-db.sqlite',
        driver: sqlite3.Database
    });
    console.log('Connected to the SQLite database.');
})();

app.use(express.static(path.join(__dirname, 'public')));

// --- MODIFIED: API Search Endpoint ---
app.get('/api/search', async (req, res) => {
    try {
        const { query, categories, excludedCategories } = req.query;
        const includeTags = categories ? categories.split(',').map(t => t.trim().toLowerCase()) : [];
        const excludeTags = excludedCategories ? excludedCategories.split(',').map(t => t.trim().toLowerCase()) : [];

        let sql = `SELECT url, title, synopsis, categories FROM stories`;
        const params = [];
        let whereClauses = [];

        if (query) {
            whereClauses.push(`title LIKE ?`);
            params.push(`%${query}%`);
        }

        includeTags.forEach(tag => {
            whereClauses.push(`categories LIKE ?`);
            params.push(`%${tag}%`);
        });
        
        excludeTags.forEach(tag => {
            whereClauses.push(`categories NOT LIKE ?`);
            params.push(`%${tag}%`);
        });

        if (whereClauses.length > 0) {
            sql += ' WHERE ' + whereClauses.join(' AND ');
        }

        sql += ' ORDER BY title;';

        const stories = await db.all(sql, params);
        
        const formattedStories = stories.map(story => ({
            ...story,
            categories: story.categories ? story.categories.split(',') : []
        }));
        
        res.json(formattedStories);

    } catch (error) {
        console.error("API Search Error:", error);
        res.status(500).json({ error: 'Failed to fetch stories from the database.' });
    }
});

const schedule = process.env.SCRAPE_SCHEDULE || '0 * * * *';
console.log(`Scheduling scraper to run on cron schedule: "${schedule}"`);
cron.schedule(schedule, () => {
    console.log('Cron job triggered: Running the scraper...');
    runScraper();
});

app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});