import TelegramBot from "node-telegram-bot-api";
import express from "express";
import { askClaude, generateScheduledMessage } from "./claude.js";
import { getUser, upsertUser, clearHistory, getVocabLog } from "./db.js";
import { generateNewsDigest } from "./scheduler.js";
import { getUserPreferences, setUserNewsTopics } from "./db.js";
import { TOPIC_FEEDS, TOPIC_KEYS } from "./news.js";
import { startTutorSession, handleSessionAnswer, skipSession, startGrammarSession } from "./tutor.js";
import { startListeningSession, handleListeningAnswer, endListeningSession, getListeningSession } from "./listening.js";
import { getUserVocabStats, getTotalVocabCount } from "./srs.js";
import { getGrammarStats, getTotalGrammarCount } from "./grammar_srs.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RAILWAY_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : null;

export let bot;

// Track topic selection state per user
const topicSelectionState = new Map(); // chatId → Set of selected topics

function buildTopicKeyboard(selectedTopics) {
  const selected = new Set(selectedTopics);
  const rows = [];
  const keys = TOPIC_KEYS;

  // 2 buttons per row
  for (let i = 0; i < keys.length; i += 2) {
    const row = [];
    for (let j = i; j < Math.min(i + 2, keys.length); j++) {
      const key = keys[j];
      const feed = TOPIC_FEEDS[key];
      const isSelected = selected.has(key);
      row.push({
        text: `${isSelected ? "✅ " : ""}${feed.emoji} ${feed.name}`,
        callback_data: `topic_toggle_${key}`,
      });
    }
    rows.push(row);
  }

  // Done button
  rows.push([{
    text: `✅ Done (${selected.size}/3 selected)`,
    callback_data: "topic_done",
  }]);

  return { inline_keyboard: rows };
}

const COMMANDS = [
  { command: "start", description: "Meet your Japanese tutor Hana" },
  { command: "news", description: "Get today's news digest right now" },
  { command: "topics", description: "Choose your news topics (up to 3)" },
  { command: "practice", description: "Start vocab practice session (12 questions)" },
  { command: "grammar", description: "Start N3 grammar session (8 questions)" },
  { command: "skipsession", description: "Skip the current practice session" },
  { command: "listening", description: "Start tonight's listening session now" },
  { command: "skiplatest", description: "Skip the current listening session" },
  { command: "level", description: "Set your Japanese level (e.g. /level N4)" },
  { command: "style", description: "Set tutor style: strict, encouraging, casual" },
  { command: "progress", description: "See your overall vocabulary progress" },
  { command: "vocab", description: "Review your recent vocabulary" },
  { command: "reset", description: "Clear conversation history and start fresh" },
  { command: "help", description: "Show all commands" },
];

async function showTopicSelector(chatId, botInstance) {
  const prefs = getUserPreferences(chatId);
  const current = prefs.news_topics || [];
  topicSelectionState.set(chatId, new Set(current));

  await botInstance.sendMessage(chatId,
    "\u{1F4F0} *Choose up to 3 news topics*

Tap to select/deselect, then tap \u2705 Done when finished:",
    {
      parse_mode: "Markdown",
      reply_markup: buildTopicKeyboard(current),
    }
  );
}

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

  // /news
  bot.onText(/\/news/, async (msg) => {
    const chatId = msg.chat.id.toString();
    const prefs = getUserPreferences(chatId);
    if (!prefs.news_topics || prefs.news_topics.length === 0) {
      // No topics set — redirect to topic selection
      await showTopicSelector(chatId, bot);
    } else {
      await bot.sendMessage(chatId, "📰 Fetching your news digest... give me a moment!");
      await generateNewsDigest(chatId);
    }
  });

  // /topics — topic selection
  bot.onText(/\/topics/, async (msg) => {
    const chatId = msg.chat.id.toString();
    await showTopicSelector(chatId, bot);
  });

  // Handle inline keyboard callbacks
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id.toString();
    const data = query.data;

    if (data.startsWith("topic_toggle_")) {
      const topicKey = data.replace("topic_toggle_", "");
      const current = topicSelectionState.get(chatId) || new Set();

      if (current.has(topicKey)) {
        current.delete(topicKey);
      } else if (current.size < 3) {
        current.add(topicKey);
      } else {
        await bot.answerCallbackQuery(query.id, {
          text: "You can only select up to 3 topics! Deselect one first.",
          show_alert: false,
        });
        return;
      }

      topicSelectionState.set(chatId, current);

      // Update the message with new keyboard
      try {
        await bot.editMessageReplyMarkup(
          buildTopicKeyboard([...current]),
          { chat_id: chatId, message_id: query.message.message_id }
        );
      } catch (e) { /* ignore if message unchanged */ }
      await bot.answerCallbackQuery(query.id);

    } else if (data === "topic_done") {
      const selected = [...(topicSelectionState.get(chatId) || new Set())];
      topicSelectionState.delete(chatId);

      if (selected.length === 0) {
        await bot.answerCallbackQuery(query.id, {
          text: "Please select at least 1 topic!",
          show_alert: true,
        });
        return;
      }

      // Save preferences
      setUserNewsTopics(chatId, selected);
      await bot.answerCallbackQuery(query.id);

      const topicNames = selected.map(k => `${TOPIC_FEEDS[k].emoji} ${TOPIC_FEEDS[k].name}`).join(", ");
      await bot.editMessageText(
        `✅ *News preferences saved!*

Your topics: ${topicNames}

Your personalised digest arrives every morning at 7am 🌅
Use /topics anytime to update your preferences.`,
        { chat_id: chatId, message_id: query.message.message_id, parse_mode: "Markdown" }
      );
    }
  });

  // /practice — manual session trigger
  bot.onText(/\/practice/, async (msg) => {
    const chatId = msg.chat.id.toString();
    upsertUser(chatId, { name: msg.from.first_name || "friend" });
    await startTutorSession(chatId, sendToChat);
  });

  // /grammar — grammar only session
  bot.onText(/\/grammar/, async (msg) => {
    const chatId = msg.chat.id.toString();
    upsertUser(chatId, { name: msg.from.first_name || "friend" });
    await startGrammarSession(chatId, sendToChat);
  });

  // /skipsession
  bot.onText(/\/skipsession/, async (msg) => {
    const chatId = msg.chat.id.toString();
    const skipped = skipSession(chatId);
    if (skipped) {
      await bot.sendMessage(chatId, "⏭️ Session skipped! Chat freely or start a new one with /practice.");
    } else {
      await bot.sendMessage(chatId, "No active session to skip!");
    }
  });

  // /level N3
  bot.onText(/\/level (.+)/, async (msg, match) => {
    const chatId = msg.chat.id.toString();
    const level = match[1].trim();
    const validLevels = ["beginner", "N5", "N4", "N3", "N2", "N1"];
    if (!validLevels.includes(level)) {
      await bot.sendMessage(chatId, `Please use one of these levels: ${validLevels.join(", ")}\nExample: /level N4`);
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
      await bot.sendMessage(chatId, `Please use one of: ${validStyles.join(", ")}\nExample: /style casual`);
      return;
    }
    upsertUser(chatId, { tutor_style: style });
    await bot.sendMessage(chatId, `✅ Tutor style set to *${style}*!`, { parse_mode: "Markdown" });
  });

  // /progress
  bot.onText(/\/progress/, async (msg) => {
    const chatId = msg.chat.id.toString();
    const stats = getUserVocabStats(chatId);
    const totals = getTotalVocabCount();

    if (!stats || stats.total_seen === 0) {
      await bot.sendMessage(chatId, "No vocabulary progress yet! Start with /practice to begin learning 📚");
      return;
    }

    const n4Pct = totals.n4_total > 0 ? Math.round((stats.n4_seen / totals.n4_total) * 100) : 0;
    const n3Pct = totals.n3_total > 0 ? Math.round((stats.n3_seen / totals.n3_total) * 100) : 0;
    const totalPct = totals.total > 0 ? Math.round((stats.total_seen / totals.total) * 100) : 0;

    const grammarStats = getGrammarStats(chatId);
    const grammarTotals = getTotalGrammarCount();
    const grammarPct = grammarTotals.total > 0
      ? Math.round(((grammarStats?.total_seen || 0) / grammarTotals.total) * 100) : 0;

    const message = `📊 *Your Learning Progress*

📚 *Vocabulary: ${stats.total_seen}/${totals.total} words (${totalPct}%)*
  📘 N4: ${stats.n4_seen}/${totals.n4_total} (${n4Pct}%)
  📗 N3: ${stats.n3_seen}/${totals.n3_total} (${n3Pct}%)
  🌱 Learning: ${stats.learning || 0}  🔄 Reviewing: ${stats.reviewing || 0}  ⭐ Mastered: ${stats.mastered || 0}

📝 *Grammar: ${grammarStats?.total_seen || 0}/${grammarTotals.total} patterns (${grammarPct}%)*
  🌱 Learning: ${grammarStats?.learning || 0}  🔄 Reviewing: ${grammarStats?.reviewing || 0}  ⭐ Mastered: ${grammarStats?.mastered || 0}

${(stats.mastered || 0) + (grammarStats?.mastered || 0) > 0 ? "素晴らしい！Keep it up! 🎉" : "がんばって！Every session moves you forward! 💪"}`;

    await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  });

  // /vocab
  bot.onText(/\/vocab/, async (msg) => {
    const chatId = msg.chat.id.toString();
    const vocab = getVocabLog(chatId, 15);
    if (vocab.length === 0) {
      await bot.sendMessage(chatId, "No vocabulary logged yet! Start a session with /practice 📚");
      return;
    }
    const list = vocab.map(v =>
      `• ${v.word} (${v.reading}) = ${v.meaning} — seen ${v.times_seen}x, confidence: ${v.confidence}`
    ).join("\n");
    await bot.sendMessage(chatId, `📚 *Your recent vocabulary:*\n\n${list}`, { parse_mode: "Markdown" });
  });

  // /listening — manual trigger
  bot.onText(/\/listening/, async (msg) => {
    const chatId = msg.chat.id.toString();
    upsertUser(chatId, { name: msg.from.first_name || "friend" });
    await startListeningSession(chatId, bot);
  });

  // /skiplatest — skip active listening session
  bot.onText(/\/skiplatest/, async (msg) => {
    const chatId = msg.chat.id.toString();
    const session = getListeningSession(chatId);
    if (session) {
      endListeningSession(session.id);
      await bot.sendMessage(chatId, "⏭️ リスニングセッションをスキップしました！/listening でまたいつでも始められます。");
    } else {
      await bot.sendMessage(chatId, "アクティブなリスニングセッションはありません。");
    }
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

  // All regular messages
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
      // Check listening session first (9pm)
      const handledByListening = await handleListeningAnswer(chatId, msg.text, bot);
      if (handledByListening) return;

      // Check vocab/grammar session (3pm)
      const handledBySession = await handleSessionAnswer(chatId, msg.text, sendToChat);
      if (handledBySession) return;

      // Free conversation temporarily disabled
      await bot.sendMessage(chatId,
        "🚧 Free chat is coming soon!\n\nFor now, use these commands:\n/practice — vocab session\n/grammar — grammar session\n/listening — listening practice\n/news — today's news digest\n/help — all commands"
      );

    } catch (err) {
      console.error("Message handling error:", err);
      await bot.sendMessage(chatId, "Hmm, something went wrong. Try again in a moment! 🙏");
    }
  });
}

export async function startBot() {
  if (RAILWAY_URL) {
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
