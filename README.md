# mcstories-search-v2-selfhost

MCStories Search & Scraper

This is a self-hosted, automated web scraper and search interface for stories from [suspicious link removed]. It uses a Node.js backend with Express, a scheduled scraper that populates a local SQLite database, and an Nginx reverse proxy for production deployment. Includes a Git webhook for fully automated deployments.

Features

    Automated Scraping: A scheduled cron job sequentially scrapes story categories and their synopses.

    Web Interface: A clean front-end with search by title and filtering by included/excluded categories.

    Batch Saving: Scraped data is saved to the database in batches of 10 for reliability.

    Dark/Light Mode: A theme toggle for user preference, saved in local storage.

    Automated Deployment: Automatically pulls the latest changes from Git and restarts the server via a GitHub webhook.

    Production Ready: Managed by the PM2 process manager and served securely via an Nginx reverse proxy.

Technology Stack

    Backend: Node.js, Express.js

    Database: SQLite3

    Scraping: Cheerio, Cloudflare Browser Rendering API

    Process Manager: PM2

    Reverse Proxy: Nginx

    Automation: node-cron, Git Webhooks

Prerequisites

Before you begin, ensure you have the following installed on your Linux server (e.g., Ubuntu 22.04):

    Node.js (version 18 or higher)

    Git

    Nginx

    PM2 (sudo npm install pm2 -g)

    A Cloudflare account with an API Token for Browser Rendering.

Installation & Configuration

1. Clone the Repository

Clone your project repository onto the server.
Bash

git clone <your-repository-url>
cd <your-project-directory>

2. Install Dependencies

Install the required Node.js packages.
Bash

npm install

3. Create and Configure the Environment File

Create a .env file to store your configuration variables.
Bash

touch .env

Open the file (nano .env) and add the following content, replacing the placeholder values with your own.
Ini, TOML

# Server Configuration
PORT=3000

# Database Configuration
DATABASE_PATH=/path/to/your/project/database/mcstories-db.sqlite

# Scraper Configuration
SCRAPE_SCHEDULE='0 * * * *' # Runs at the top of every hour

# Cloudflare Credentials
CLOUDFLARE_ACCOUNT_ID=YOUR_CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN=YOUR_CLOUDFLARE_BROWSER_RENDERING_API_TOKEN

# Webhook Secret for Automated Deployment
WEBHOOK_SECRET=YOUR_SUPER_STRONG_AND_RANDOM_SECRET_STRING

Note: It is highly recommended to use an absolute path for DATABASE_PATH.

4. Database Setup

You need to create and initialize the SQLite database with the correct schema.

    Create the database directory and file:
    Bash

    mkdir database
    touch database/mcstories-db.sqlite

    Use a tool like sqlite3 on the command line or a GUI tool like DB Browser for SQLite to execute the following SQL commands on your new database file.

SQL

-- Create the main stories table
CREATE TABLE stories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    url TEXT UNIQUE NOT NULL,
    synopsis TEXT,
    categories TEXT,
    last_scraped_at TEXT DEFAULT (datetime('now'))
);

-- Create the state-tracking table for the scraper
CREATE TABLE scrape_state (
    id INTEGER PRIMARY KEY,
    last_scraped_category_index INTEGER
);

-- Initialize the scraper to start at the beginning
INSERT INTO scrape_state (id, last_scraped_category_index) VALUES (1, -1);

5. Configure Nginx as a Reverse Proxy

Set up Nginx to direct public traffic from port 80 to your Node.js app running on port 3000.

    Create a new Nginx configuration file:
    Bash

sudo nano /etc/nginx/sites-available/mcstories

Paste in the following configuration, replacing your_server_ip_or_domain with your server's public IP address or domain name.
Nginx

server {
    listen 80;
    listen [::]:80;

    server_name your_server_ip_or_domain;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

Enable the new site and test the configuration:
Bash

    sudo ln -s /etc/nginx/sites-available/mcstories /etc/nginx/sites-enabled/
    sudo rm /etc/nginx/sites-enabled/default
    sudo nginx -t
    sudo systemctl reload nginx

Running the Application with PM2

1. Initial Start

Start your server using PM2.
Bash

pm2 start server.js --name mcstories-server

2. Configure for Auto-Boot

To ensure your application restarts automatically when the server reboots:
Bash

# This generates a command, copy and paste the output to run it
pm2 startup

# Save the current process list to be restored on boot
pm2 save

3. Managing the Application

    Check status: pm2 status

    View logs: pm2 logs mcstories-server

    Restart: pm2 restart mcstories-server

Automated Deployment Setup

1. Create the Deployment Script

Create a file named deploy.sh in your project's root directory and add the following content. Make sure to set the correct absolute path for cd.
Bash

#!/bin/bash
set -e

# Navigate to your project directory
cd /path/to/your/project/

echo "--- Starting deployment at $(date) ---"
git fetch origin main
git reset --hard origin/main
echo "Restarting pm2 server..."
pm2 restart mcstories-server
echo "--- Deployment finished successfully ---"

Make the script executable:
Bash

chmod +x deploy.sh

2. Configure the GitHub Webhook

    In your GitHub repository, go to Settings > Webhooks > Add webhook.

    Payload URL: http://your_server_ip_or_domain/git-webhook

    Content type: application/json

    Secret: Enter the same strong secret string you set for WEBHOOK_SECRET in your .env file.

    Select "Just the push event."

    Click Add webhook. Now, every push to your main branch will automatically deploy the changes.
