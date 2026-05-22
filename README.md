# 🇯🇵 Japanese Tutor Bot — Hana

A personal Japanese tutor that lives in your Telegram, powered by Claude AI.

---

## Features (Phase 1 — Core Bot)
- Chat freely with Hana, your Japanese tutor
- Set your level (beginner → N1) and she adapts instantly
- Choose tutor style: strict, encouraging, or casual
- Vocabulary tracking
- Persistent conversation memory

## Coming next (Phase 2)
- 7am daily news digest in Japanese
- Scheduled tutoring sessions throughout the day
- Google Calendar integration for evening debrief

---

## Setup Guide

### Step 1 — Create your Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Give it a name (e.g. "My Japanese Tutor") and username (e.g. `hana_japanese_bot`)
4. BotFather gives you a **token** — copy it, you'll need it

### Step 2 — Get your Anthropic API Key

1. Go to https://console.anthropic.com
2. Sign up / log in
3. Go to **API Keys** → Create new key
4. Copy the key

### Step 3 — Deploy to Railway (runs 24/7, no laptop needed)

1. Push this code to a GitHub repo:
   ```bash
   git init
   git add .
   git commit -m "initial commit"
   # create a repo on github.com, then:
   git remote add origin https://github.com/YOUR_USERNAME/japanese-tutor-bot.git
   git push -u origin main
   ```

2. Go to https://railway.app and sign up with GitHub

3. Click **New Project** → **Deploy from GitHub repo** → select your repo

4. Go to your project → **Variables** tab → add these:
   ```
   TELEGRAM_BOT_TOKEN = your_token_from_botfather
   ANTHROPIC_API_KEY  = your_anthropic_key
   ```

5. Railway auto-deploys. Your bot is now live 24/7! 🎉

### Step 4 — Talk to your bot

1. Find your bot on Telegram (search the username you gave it)
2. Send `/start`
3. Hana will introduce herself and ask your level
4. You can also use `/level N4` to set it directly

---

## Commands

| Command | Description |
|---|---|
| `/start` | Meet Hana |
| `/level N4` | Set your Japanese level (beginner, N5, N4, N3, N2, N1) |
| `/style casual` | Set tutor style (strict, encouraging, casual) |
| `/vocab` | Review your recent vocabulary |
| `/reset` | Clear conversation history |
| `/help` | Show all commands |

---

## Local Development (optional)

```bash
# Install dependencies
npm install

# Copy env file and fill in your keys
cp .env.example .env

# Run locally
npm run dev
```

---

## Project Structure

```
index.js      → entry point, starts everything
bot.js        → Telegram bot, handles all messages and commands
claude.js     → Claude API integration, tutor personality
db.js         → SQLite database, stores users/messages/vocab
railway.toml  → Railway deployment config
```
