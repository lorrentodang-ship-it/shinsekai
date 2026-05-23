import TelegramBot from "node-telegram-bot-api";
import express from "express";
import { askClaude, generateScheduledMessage } from "./claude.js";
import { getUser, upsertUser, clearHistory, getVocabLog } from "./db.js";
import { generateNewsDigest } from "./scheduler.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RAILWAY_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : null;

export let bot;

const COMMANDS = [
  { command: "start", description: "Meet your Japanese tutor Hana" },
  { command: "level", description: "Set your Japanese level (e.g. /level N4)" },
  { command: "style", description: "Set tutor style: strict, encouraging, casual" },
  { command: "vocab", description: "Review your recent vocabulary" },
  { command: "reset", description: "Clear conversation history and start fresh" },
  { command: "help", description: "Show all commands" },
  { command: "news", description: "Get today's news digest right now" },
];

function registerHandlers() {
  // /start
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id.toString();
    const firstName = msg.from.first_name || "friend";
    upsertUser(chatId, { name: firstName });

    const greeting = await generateScheduledMessage(
      chatId,
      `The student just started the bot for the first time. Their name is ${firstName}. 
      Introduce yourself as Hana, their Japanese tutor. Be warm and exciting. 
      Ask them about their Japanese level (complete beginner, or JLPT level N5-N1). 
      Keep it short and friendly — this is a chat app.`
    );
    await bot.sendMessage(chatId, greeting, { parse_mode: "Markdown" });
  });

 // /news - manual trigger
  bot.onText(/\/news/, async (msg) => {
    const chatId = msg.chat.id.toString();
    await bot.sendMessage(chatId, "📰 Fetching your news digest... give me a moment!");
    await generateNewsDigest();
  });
  
  // /level N3
  bot.onText(/\/level (.+)/, async (msg, match) => {
    const chatId = msg.chat.id.toString();
    const level = match[1].trim();
    const validLevels = ["beginner", "N5", "N4", "N3", "N2", "N1"];

    if (!validLevels.includes(level)) {
      await bot.sendMessage(chatId,
        `Please use one of these levels: ${validLevels.join(", ")}\nExample: /level N4`
      );
      return;
    }

    upsertUser(chatId, { japanese_level: level });
    const reply = await generateScheduledMessage(
      chatId,
      `The student just set their Japanese level to ${level}. 
      Acknowledge this enthusiastically, confirm you'll adjust your teaching, 
      and give them a quick taste of what practice at ${level} level will look like. Keep it brief.`
    );
    await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
  });

  // /style
  bot.onText(/\/style (.+)/, async (msg, match) => {
    const chatId = msg.chat.id.toString();
    const style = match[1].trim().toLowerCase();
    const validStyles = ["strict", "encouraging", "casual"];

    if (!validStyles.includes(style)) {
      await bot.sendMessage(chatId,
        `Please use one of: ${validStyles.join(", ")}\nExample: /style casual`
      );
      return;
    }
    upsertUser(chatId, { tutor_style: style });
    await bot.sendMessage(chatId, `✅ Tutor style set to *${style}*!`, { parse_mode: "Markdown" });
  });

  // /vocab
  bot.onText(/\/vocab/, async (msg) => {
    const chatId = msg.chat.id.toString();
    const vocab = getVocabLog(chatId, 15);

    if (vocab.length === 0) {
      await bot.sendMessage(chatId, "No vocabulary logged yet! Start chatting and I'll track new words for you 📚");
      return;
    }
    const list = vocab.map(v =>
      `• ${v.word} (${v.reading}) = ${v.meaning} — seen ${v.times_seen}x`
    ).join("\n");
    await bot.sendMessage(chatId, `📚 *Your recent vocabulary:*\n\n${list}`, { parse_mode: "Markdown" });
  });

  // /reset
  bot.onText(/\/reset/, async (msg) => {
    const chatId = msg.chat.id.toString();
    clearHistory(chatId);
    await bot.sendMessage(chatId, "🔄 Conversation history cleared! Fresh start — what would you like to practice?");
  });

  // /help
  bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id.toString();
    const helpText = COMMANDS.map(c => `/${c.command} — ${c.description}`).join("\n");
    await bot.sendMessage(chatId, `🤖 *Hana's Commands:*\n\n${helpText}`, { parse_mode: "Markdown" });
  });

  // All regular messages → Claude
  bot.on("message", async (msg) => {
    if (msg.text?.startsWith("/")) return;
    if (!msg.text) {
      await bot.sendMessage(msg.chat.id, "I can only read text messages for now! 😊");
      return;
    }

    const chatId = msg.chat.id.toString();
    upsertUser(chatId, { name: msg.from.first_name || "friend" });
    await bot.sendChatAction(chatId, "typing");

    try {
      const reply = await askClaude(chatId, msg.text);
      await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("Claude error:", err);
      await bot.sendMessage(chatId, "Hmm, something went wrong on my end. Try again in a moment! 🙏");
    }
  });
}

export async function startBot() {
  if (RAILWAY_URL) {
    // --- WEBHOOK MODE (production on Railway) ---
    console.log("🔗 Starting in webhook mode:", RAILWAY_URL);

    const app = express();
    app.use(express.json());

    bot = new TelegramBot(TOKEN, { webHook: false });

    app.post(`/bot${TOKEN}`, (req, res) => {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    });

    app.listen(3000, () => {
      console.log("🌐 Express server listening on port 3000");
    });

    await bot.setWebHook(`${RAILWAY_URL}/bot${TOKEN}`);
    console.log("✅ Webhook set:", `${RAILWAY_URL}/bot${TOKEN}`);

  } else {
    // --- POLLING MODE (local development) ---
    console.log("🔄 Starting in polling mode (local)");
    bot = new TelegramBot(TOKEN, { polling: true });
  }

  await bot.setMyCommands(COMMANDS);
  registerHandlers();
  console.log("✅ Telegram bot listening for messages...");
}

export async function sendToChat(chatId, message) {
  return bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
}
