import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { fetchTopHeadlines, formatHeadlinesForClaude } from "./news.js";
import { sendToChat, bot } from "./bot.js";
import { getUser, db } from "./db.js";
import { startTutorSession, startGrammarSession } from "./tutor.js";
import { startListeningSession } from "./listening.js";
import { sendVoiceMessage } from "./tts.js";

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

Create a morning news digest. Respond in JSON only — no markdown, no preamble:
{
  "greeting": "warm おはようございます opening line with today's energy (1-2 sentences)",
  "stories": [
    {
      "headline_ja": "headline translated naturally into Japanese",
      "summary_ja": "1-2 sentence explanation in Japanese",
      "vocab": [
        {"word": "単語", "reading": "たんご", "meaning": "vocabulary word"}
      ],
      "audio_text": "the headline and summary combined as natural spoken Japanese — NO vocab lists, just the story text, written to sound natural when read aloud"
    }
  ],
  "closing": "short encouraging closing line mixing Japanese and English, referencing today's weather or energy"
}

Include 4-5 stories covering Vietnam, Asia, global international affairs, and science.
Student's Japanese level: ${level}
Keep Japanese complexity appropriate for their level.
Pick 2-3 vocab words per story.
Keep audio_text clean — no bullet points, no emoji, just natural spoken sentences.`;

    const response = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = response.content[0].text.replace(/```json|```/g, "").trim();
    const digest = JSON.parse(raw);

    // Send greeting
    await sendToChat(YOUR_CHAT_ID, digest.greeting);
    await new Promise(r => setTimeout(r, 1000));

    // Send each story: text first, then audio
    for (let i = 0; i < digest.stories.length; i++) {
      const story = digest.stories[i];

      // Build text message with vocab (for reading)
      const vocabLines = story.vocab
        .map(v => `📚 ${v.word} (${v.reading}) = ${v.meaning}`)
        .join("\n");

      const textMessage = `*${story.headline_ja}*\n\n${story.summary_ja}\n\n${vocabLines}`;
      await sendToChat(YOUR_CHAT_ID, textMessage);
      await new Promise(r => setTimeout(r, 500));

      // Send audio — clean story text only, no vocab
      await sendVoiceMessage(bot, YOUR_CHAT_ID, story.audio_text, `news_story_${i}`);
      await new Promise(r => setTimeout(r, 1500));
    }

    // Send closing
    await sendToChat(YOUR_CHAT_ID, digest.closing);
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

    await sendToChat(YOUR_CHAT_ID,
      `こんにちは、${name}！🌸 Time for your afternoon Japanese practice!\n\nReady for today's vocab & grammar session? Let's go! 💪`
    );

    await new Promise(r => setTimeout(r, 2000));
    await startTutorSession(YOUR_CHAT_ID, sendToChat);

  } catch (err) {
    console.error("❌ Tutor session error:", err);
    await sendToChat(YOUR_CHAT_ID, "Sorry, I couldn't start your practice session. Try /practice manually! 🙏");
  }
}

// ── Afternoon grammar session ─────────────────────────
async function triggerGrammarSession() {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const recentGrammar = db.prepare(
      `SELECT * FROM tutor_sessions 
       WHERE chat_id = ? AND session_type = 'grammar' AND started_at >= ? 
       ORDER BY started_at DESC LIMIT 1`
    ).get(YOUR_CHAT_ID, todayStart.toISOString());

    if (recentGrammar) {
      console.log("⏭️ Skipping grammar trigger — already done today");
      return;
    }

    const user = getUser(YOUR_CHAT_ID);
    const name = user?.name || "friend";
    await sendToChat(YOUR_CHAT_ID,
      `${name}、文法の練習の時間です！📝 Ready for your N3 grammar session?`
    );
    await new Promise(r => setTimeout(r, 2000));
    await startGrammarSession(YOUR_CHAT_ID, sendToChat);
  } catch (err) {
    console.error("❌ Grammar session error:", err);
    await sendToChat(YOUR_CHAT_ID, "Sorry, couldn't start grammar session. Try /grammar manually! 🙏");
  }
}

// ── Evening listening session ─────────────────────────
async function triggerListeningSession() {
  console.log("🎧 9pm Vietnam — triggering listening session");
  try {
    await startListeningSession(YOUR_CHAT_ID, bot);
  } catch (err) {
    console.error("❌ Listening session error:", err);
    await sendToChat(YOUR_CHAT_ID, "申し訳ありません！リスニングセッションを開始できませんでした。/listening で試してください！🙏");
  }
}

// ── Scheduler ─────────────────────────────────────────
export function startScheduler() {
  // 7:00am Vietnam time
  cron.schedule("0 7 * * *", async () => {
    console.log("⏰ 7am Vietnam — sending morning news digest");
    await generateNewsDigest();
  }, { timezone: "Asia/Ho_Chi_Minh" });

  // 3:00pm Vietnam time — vocab session
  cron.schedule("0 15 * * *", async () => {
    console.log("⏰ 3pm Vietnam — starting vocab session");
    await triggerTutorSession();
  }, { timezone: "Asia/Ho_Chi_Minh" });

  // 4:30pm Vietnam time — grammar session
  cron.schedule("30 16 * * *", async () => {
    console.log("⏰ 4:30pm Vietnam — starting grammar session");
    await triggerGrammarSession();
  }, { timezone: "Asia/Ho_Chi_Minh" });

  // 9:00pm Vietnam time
  cron.schedule("0 21 * * *", async () => {
    console.log("⏰ 9pm Vietnam — starting listening session");
    await triggerListeningSession();
  }, { timezone: "Asia/Ho_Chi_Minh" });

  console.log("✅ Scheduler started:");
  console.log("   📰 News digest at 7:00am Vietnam time");
  console.log("   ✏️  Tutoring session at 3:00pm Vietnam time");
  console.log("   🎧 Listening session at 9:00pm Vietnam time");
}

export { generateNewsDigest, triggerTutorSession, triggerGrammarSession, triggerListeningSession };
