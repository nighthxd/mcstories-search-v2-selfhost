// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { runScraper } = require('./scrapers/scheduled-scraper');

const app = express();
const PORT = process.env.PORT || 3000;
let db;

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