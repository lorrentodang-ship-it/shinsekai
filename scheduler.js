import cron from "node-cron";
import { sendToChat, bot } from "./bot.js";
import { getUser, db, getActiveNewsTopics, getCachedStoriesForUser, getUserPreferences } from "./db.js";
import { startTutorSession, startGrammarSession } from "./tutor.js";
import { startListeningSession } from "./listening.js";
import { fetchActiveTopics } from "./news.js";
import { generateGradedStory, ensureTTSCached, levelToNewsTier } from "./news_generator.js";
import { TOPIC_FEEDS } from "./news.js";

const YOUR_CHAT_ID = process.env.MY_CHAT_ID || "985242254";

// ── Get today's cache date string ─────────────────────
function todayStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }); // YYYY-MM-DD
}

// ── Morning news generation (runs at 6:45am — before delivery) ──
export async function generateDailyNews() {
  console.log("📰 Generating daily news cache...");
  const cacheDate = todayStr();

  // Step 1: which topics are selected by any user?
  const activeTopics = getActiveNewsTopics();
  if (activeTopics.length === 0) {
    console.log("ℹ️  No users have selected topics yet — skipping news generation");
    return;
  }
  console.log(`📋 Active topics: ${activeTopics.join(", ")}`);

  // Step 2: fetch RSS for active topics only
  const articles = await fetchActiveTopics(activeTopics);
  console.log(`📄 Fetched ${articles.length} articles`);

  // Step 3: generate graded versions for each article
  for (let i = 0; i < articles.length; i++) {
    const article = { ...articles[i], storyIndex: i };
    try {
      await generateGradedStory(article, cacheDate);
      console.log(`  ✅ Generated: [${article.topic}] ${article.title.slice(0, 50)}`);
    } catch (err) {
      console.error(`  ❌ Failed: [${article.topic}]`, err.message);
    }
  }
  console.log("✅ Daily news cache ready!");
}

// ── Deliver news to a single user ────────────────────
async function deliverNewsToUser(chatId) {
  const user = getUser(chatId);
  const prefs = getUserPreferences(chatId);
  const userTopics = prefs.news_topics || [];

  if (userTopics.length === 0) {
    await sendToChat(chatId,
      "おはようございます！📰\n\nYou haven't selected your news topics yet!\nUse /topics to pick up to 3 topics and I'll send you personalised news every morning."
    );
    return;
  }

  const tier = levelToNewsTier(user?.japanese_level);
  const cacheDate = todayStr();
  const stories = getCachedStoriesForUser(cacheDate, userTopics);

  if (stories.length === 0) {
    await sendToChat(chatId, "おはようございます！今日のニュースの準備ができていません。少し後でもう一度お試しください。🙏");
    return;
  }

  // Greeting
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "Asia/Ho_Chi_Minh"
  });
  await sendToChat(chatId, `おはようございます！🌅 *${today}*\n\nHere are your personalised news stories:`);
  await new Promise(r => setTimeout(r, 800));

  // Send up to 3 stories
  const toSend = stories.slice(0, 3);
  for (const story of toSend) {
    try {
      const topicInfo = TOPIC_FEEDS[story.topic];
      const emoji = topicInfo?.emoji || "📰";
      const summaryKey  = `${tier}_summary`;
      const vocabKey    = `${tier}_vocab`;

      const summary = story[summaryKey];
      const vocabRaw = story[vocabKey];
      const vocab = typeof vocabRaw === "string" ? JSON.parse(vocabRaw) : vocabRaw;
      const vocabLines = (vocab || []).map(v => `📚 ${v.word} (${v.reading}) = ${v.meaning}`).join("\n");

      // Escape underscores to prevent Telegram Markdown errors
      const safeHeadline = story.headline_ja.replace(/_/g, "\\_");
      const safeSummary  = summary.replace(/_/g, "\\_");

      const textMsg = `${emoji} *${safeHeadline}*\n\n${safeSummary}\n\n${vocabLines}`;
      await sendToChat(chatId, textMsg);
      await new Promise(r => setTimeout(r, 500));

      // Send TTS audio (cached)
      try {
        const fileId = await ensureTTSCached(bot, chatId, story, tier);
        if (fileId) {
          await bot.sendVoice(chatId, fileId);
          await new Promise(r => setTimeout(r, 1000));
        }
      } catch (ttsErr) {
        console.warn("TTS send failed:", ttsErr.message);
      }
    } catch (storyErr) {
      console.error("Story delivery error:", storyErr.message);
    }
  }

  // Closing
  const topicNames = userTopics.map(t => TOPIC_FEEDS[t]?.name || t).join(", ");
  await sendToChat(chatId, `_Topics: ${topicNames} | Level: ${tier} | Use /topics to update preferences_`);
}

// ── Morning news digest (deliver to all users) ────────
async function triggerMorningNews() {
  console.log("⏰ 7am — delivering news to all users");
  const users = db.prepare("SELECT chat_id FROM users").all();
  for (const user of users) {
    try {
      await deliverNewsToUser(user.chat_id);
      await new Promise(r => setTimeout(r, 500)); // slight delay between users
    } catch (err) {
      console.error(`❌ News delivery failed for ${user.chat_id}:`, err.message);
    }
  }
}

// ── Manual news trigger (for /news command) ───────────
export async function generateNewsDigest(chatIdOverride) {
  const chatId = chatIdOverride || YOUR_CHAT_ID;
  // Generate cache first if not already done today
  await generateDailyNews();
  await deliverNewsToUser(chatId);
}

// ── Afternoon vocab session ───────────────────────────
async function triggerTutorSession() {
  console.log("✏️ 3pm — triggering vocab session");
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const recentSession = db.prepare(
      `SELECT * FROM tutor_sessions WHERE chat_id = ? AND session_type = 'vocab' AND started_at >= ? ORDER BY started_at DESC LIMIT 1`
    ).get(YOUR_CHAT_ID, todayStart.toISOString());

    if (recentSession) {
      console.log("⏭️ Skipping 3pm — vocab session already done today");
      return;
    }

    const user = getUser(YOUR_CHAT_ID);
    const name = user?.name || "friend";
    await sendToChat(YOUR_CHAT_ID, `こんにちは、${name}！🌸 Time for your afternoon vocab practice! 💪`);
    await new Promise(r => setTimeout(r, 2000));
    await startTutorSession(YOUR_CHAT_ID, sendToChat);
  } catch (err) {
    console.error("❌ Tutor session error:", err);
    await sendToChat(YOUR_CHAT_ID, "Sorry, couldn't start vocab session. Try /practice manually! 🙏");
  }
}

// ── Grammar session ───────────────────────────────────
async function triggerGrammarSession() {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const recentGrammar = db.prepare(
      `SELECT * FROM tutor_sessions WHERE chat_id = ? AND session_type = 'grammar' AND started_at >= ? ORDER BY started_at DESC LIMIT 1`
    ).get(YOUR_CHAT_ID, todayStart.toISOString());

    if (recentGrammar) {
      console.log("⏭️ Skipping grammar — already done today");
      return;
    }

    const user = getUser(YOUR_CHAT_ID);
    const name = user?.name || "friend";
    await sendToChat(YOUR_CHAT_ID, `${name}、文法の練習の時間です！📝 Ready for your N3 grammar session?`);
    await new Promise(r => setTimeout(r, 2000));
    await startGrammarSession(YOUR_CHAT_ID, sendToChat);
  } catch (err) {
    console.error("❌ Grammar session error:", err);
    await sendToChat(YOUR_CHAT_ID, "Sorry, couldn't start grammar session. Try /grammar manually! 🙏");
  }
}

// ── Listening session ─────────────────────────────────
async function triggerListeningSession() {
  console.log("🎧 9pm — triggering listening session");
  try {
    await startListeningSession(YOUR_CHAT_ID, bot);
  } catch (err) {
    console.error("❌ Listening session error:", err);
    await sendToChat(YOUR_CHAT_ID, "申し訳ありません！/listening で試してください！🙏");
  }
}

// ── Scheduler ─────────────────────────────────────────
export function startScheduler() {
  // 6:45am — pre-generate news cache before delivery
  cron.schedule("45 6 * * *", async () => {
    console.log("⏰ 6:45am — pre-generating news cache");
    await generateDailyNews();
  }, { timezone: "Asia/Ho_Chi_Minh" });

  // 7:00am — deliver to all users
  cron.schedule("0 7 * * *", async () => {
    console.log("⏰ 7am — delivering morning news");
    await triggerMorningNews();
  }, { timezone: "Asia/Ho_Chi_Minh" });

  // 3:00pm — vocab session
  cron.schedule("0 15 * * *", async () => {
    await triggerTutorSession();
  }, { timezone: "Asia/Ho_Chi_Minh" });

  // 4:30pm — grammar session
  cron.schedule("30 16 * * *", async () => {
    await triggerGrammarSession();
  }, { timezone: "Asia/Ho_Chi_Minh" });

  // 9:00pm — listening session
  cron.schedule("0 21 * * *", async () => {
    await triggerListeningSession();
  }, { timezone: "Asia/Ho_Chi_Minh" });

  console.log("✅ Scheduler started:");
  console.log("   📰 News cache at 6:45am, delivery at 7:00am");
  console.log("   ✏️  Vocab session at 3:00pm");
  console.log("   📝 Grammar session at 4:30pm");
  console.log("   🎧 Listening session at 9:00pm");
}

export { triggerTutorSession, triggerGrammarSession, triggerListeningSession };
