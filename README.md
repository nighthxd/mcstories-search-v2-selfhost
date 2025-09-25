MCStories Search & Scraper 🚀
=============================

This is a self-hosted, automated web scraper and search interface for stories from \[suspicious link removed\]. It uses a Node.js backend with Express, a scheduled scraper that populates a local SQLite database, and an Nginx reverse proxy for production deployment. The project includes a Git webhook for fully automated deployments.

Features
--------

*   **Automated Scraping**: A scheduled cron job sequentially scrapes story categories and their synopses.
    
*   **Web Interface**: A clean front-end with search by title and filtering by included/excluded categories.
    
*   **Batch Saving**: Scraped data is saved to the database in batches of 10 for reliability.
    
*   **Dark/Light Mode**: A theme toggle for user preference, saved in local storage.
    
*   **Automated Deployment**: Automatically pulls the latest changes from Git and restarts the server via a GitHub webhook.
    
*   **Production Ready**: Managed by the PM2 process manager and served securely via an Nginx reverse proxy.
    

Technology Stack
----------------

*   **Backend**: Node.js, Express.js
    
*   **Database**: SQLite3
    
*   **Scraping**: Cheerio, Cloudflare Browser Rendering API
    
*   **Process Manager**: PM2
    
*   **Reverse Proxy**: Nginx
    
*   **Automation**: node-cron, Git Webhooks
    

Installation & Configuration Guide
----------------------------------

### 1\. Prerequisites

Before you begin, ensure you have the following installed on your Linux server (e.g., Ubuntu 22.04):

*   Node.js (version 18 or higher)
    
*   Git
    
*   Nginx
    
*   PM2 (Install globally with sudo npm install pm2 -g)
    
*   A Cloudflare account with an API Token for Browser Rendering.
    

### 2\. Clone the Repository

Clone your project repository onto the server and navigate into the directory.

`git clone   cd` 

### 3\. Install Dependencies

Install the required Node.js packages.

`   npm install   `

### 4\. Create and Configure the Environment File

Create a .env file to store your configuration variables.

`   touch .env   `

Open the file (nano .env) and add the following content, replacing the placeholder values with your own.

`   # Server Configuration`  
`   PORT=3000   `

`   # Database Configuration   `
`   DATABASE_PATH=/path/to/your/project/database/mcstories-db.sqlite   `

`   # Scraper Configuration   `
`   SCRAPE_SCHEDULE='0 * * * *'   `

`   # Cloudflare Credentials   `
`   CLOUDFLARE_ACCOUNT_ID=YOUR_CLOUDFLARE_ACCOUNT_ID   `
`   CLOUDFLARE_API_TOKEN=YOUR_CLOUDFLARE_BROWSER_RENDERING_API_TOKEN   `

`   # Webhook Secret for Automated Deployment   `
`   WEBHOOK_SECRET=YOUR_SUPER_STRONG_AND_RANDOM_SECRET_STRING   `

**Note:** It is highly recommended to use an absolute path for DATABASE\_PATH.

### 5\. Database Setup

Create the database directory, file, and initialize it with the correct schema.

1.  mkdir databasetouch database/mcstories-db.sqlite
    
2.  Create the main stories table
`   CREATE TABLE stories ( id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, url TEXT UNIQUE NOT NULL, synopsis TEXT, categories TEXT, last\_scraped\_at TEXT DEFAULT (datetime('now')));-- Create the state-tracking table for the scraperCREATE TABLE scrape\_state ( id INTEGER PRIMARY KEY, last\_scraped\_category\_index INTEGER);-- Initialize the scraper to start at the beginningINSERT INTO scrape\_state (id, last\_scraped\_category\_index) VALUES (1, -1);   `
    

### 6\. Configure Nginx as a Reverse Proxy

Set up Nginx to direct public traffic from port 80 to your Node.js app.

1.  sudo nano /etc/nginx/sites-available/mcstories
    
2.  server { listen 80; listen \[::\]:80; server\_name your\_server\_ip\_or\_domain; location / { proxy\_pass http://localhost:3000; proxy\_set\_header Host $host; proxy\_set\_header X-Real-IP $remote\_addr; proxy\_set\_header X-Forwarded-For $proxy\_add\_x\_forwarded\_for; proxy\_set\_header X-Forwarded-Proto $scheme; }}
    
3.  sudo ln -s /etc/nginx/sites-available/mcstories /etc/nginx/sites-enabled/sudo rm /etc/nginx/sites-enabled/defaultsudo nginx -tsudo systemctl reload nginx
    

Running the Application
-----------------------

### 1\. Initial Start

Use PM2 to start your server and run it in the background.

`   pm2 start server.js --name mcstories-server   `

### 2\. Enable Startup on Boot

Configure PM2 to automatically restart your application when the server reboots.

`   # This generates a command. Copy and paste the output to run it.   `
`   pm2 startup   `

`   # Save the current process list to be restored on boot.   `
`   pm2 save   `

### 3\. Common PM2 Commands

*   **Check status:** pm2 status
    
*   **View live logs:** pm2 logs mcstories-server
    
*   **Restart the app:** pm2 restart mcstories-server
    

Automated Deployment with Webhooks
----------------------------------

### 1\. Create the Deployment Script

Create a deploy.sh file in your project's root. **Remember to set the correct absolute path for cd.**

`   #!/bin/bash   `
`   set -e   `

`   # Navigate to your project directory   `
`   cd /path/to/your/project/   `
`   echo "--- Starting deployment at $(date) ---"   `
`   git fetch origin main   `
`   git reset --hard origin/main   `
`   echo "Restarting pm2 server..."   `
`   pm2 restart mcstories-server   `
`   echo "--- Deployment finished successfully ---"   `

Make the script executable:

`   chmod +x deploy.sh   `

### 2\. Configure the GitHub Webhook

1.  In your GitHub repository, go to **Settings** > **Webhooks** > **Add webhook**.
    
2.  **Payload URL**: http://your\_server\_ip\_or\_domain/git-webhook
    
3.  **Content type**: application/json
    
4.  **Secret**: Enter the same strong secret string from your .env file.
    
5.  Select **"Just the push event."**
    
6.  Click **Add webhook**. Now, every push to your main branch will automatically deploy the changes.
