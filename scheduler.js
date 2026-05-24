import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { fetchTopHeadlines, formatHeadlinesForClaude } from "./news.js";
import { sendToChat } from "./bot.js";
import { getUser, db } from "./db.js";
import { startTutorSession } from "./tutor.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const YOUR_CHAT_ID = process.env.MY_CHAT_ID || "985242254";

// ── Morning news digest ───────────────────────────────
async function generateNewsDigest() {
  console.log("📰 Fetching news for morning digest...");
  try {
    const grouped = await fetchTopHeadlines();
    const headlinesText = formatHeadlinesForClaude(grouped);

    if (!headlinesText) {
      await sendToChat(YOUR_CHAT_ID, "おはようございます！ニュースの取得に失敗しました。また後で試してみます。");
      return;
    }

    const user = getUser(YOUR_CHAT_ID);
    const level = user?.japanese_level || "beginner";
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
      timeZone: "Asia/Ho_Chi_Minh"
    });

    const prompt = `You are Hana, a Japanese tutor. It's 7am in Vietnam on ${today} and you're sending your student their morning news briefing.

Here are today's top headlines:

${headlinesText}

Create a morning news digest message that:
1. Starts with a warm おはようございます greeting with today's energy
2. Covers 4-5 of the most interesting/important stories across Vietnam, SE Asia, and global news
3. For each story:
   - Give the headline in Japanese first (translate it naturally)
   - Then explain it briefly in English (2-3 sentences)
   - Pick ONE interesting vocabulary word from the Japanese headline, formatted as: 📚 word (reading) = meaning
4. End with a short encouraging line about the day ahead in a mix of Japanese and English

Student's Japanese level: ${level}
Keep Japanese complexity appropriate for their level.
Keep the whole message concise — this is a morning mobile message, not an essay.
Use emojis naturally to make it feel warm and readable.`;

    const response = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });

    await sendToChat(YOUR_CHAT_ID, response.content[0].text);
    console.log("✅ Morning news digest sent!");

  } catch (err) {
    console.error("❌ News digest error:", err);
    await sendToChat(YOUR_CHAT_ID, "おはようございます！今朝はニュースの取得に問題がありました。ごめんなさい！");
  }
}

// ── Afternoon tutoring session ────────────────────────
async function triggerTutorSession() {
  console.log("✏️ 3pm Vietnam — triggering tutoring session");
  try {
    // Skip if user already did a session today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const recentSession = db.prepare(
      `SELECT * FROM tutor_sessions 
       WHERE chat_id = ? AND started_at >= ? 
       ORDER BY started_at DESC LIMIT 1`
    ).get(YOUR_CHAT_ID, todayStart.toISOString());

    if (recentSession) {
      console.log("⏭️ Skipping 3pm trigger — session already done today");
      return;
    }

    const user = getUser(YOUR_CHAT_ID);
    const name = user?.name || "friend";

    // Send a warm opener before the session starts
    await sendToChat(YOUR_CHAT_ID,
      `こんにちは、${name}！🌸 Time for your afternoon Japanese practice!\n\nReady for today's vocab & grammar session? Let's go! 💪`
    );

    // Small delay so the opener lands first
    await new Promise(r => setTimeout(r, 2000));

    await startTutorSession(YOUR_CHAT_ID, sendToChat);
  } catch (err) {
    console.error("❌ Tutor session error:", err);
    await sendToChat(YOUR_CHAT_ID, "Sorry, I couldn't start your practice session. Try /practice manually! 🙏");
  }
}

// ── Scheduler ─────────────────────────────────────────
export function startScheduler() {
  // 7:00am Vietnam time daily
  cron.schedule("0 7 * * *", async () => {
    console.log("⏰ 7am Vietnam — sending morning news digest");
    await generateNewsDigest();
  }, { timezone: "Asia/Ho_Chi_Minh" });

  // 3:00pm Vietnam time daily
  cron.schedule("0 15 * * *", async () => {
    console.log("⏰ 3pm Vietnam — starting tutoring session");
    await triggerTutorSession();
  }, { timezone: "Asia/Ho_Chi_Minh" });

  console.log("✅ Scheduler started:");
  console.log("   📰 News digest at 7:00am Vietnam time");
  console.log("   ✏️  Tutoring session at 3:00pm Vietnam time");
}

export { generateNewsDigest, triggerTutorSession };
