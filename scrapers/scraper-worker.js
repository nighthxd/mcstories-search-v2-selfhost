// scrapers/scraper-worker.js
// Standalone entry point for the scraper, run as a forked child process by server.js.
// Keeps the main web server process free during long scrape cycles.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { runScraper } = require('./scheduled-scraper');

runScraper()
    .then(() => {
        console.log('[Worker] Scraper finished cleanly.');
        process.exit(0);
    })
    .catch(err => {
        console.error('[Worker] Scraper encountered a fatal error:', err);
        process.exit(1);
    });
