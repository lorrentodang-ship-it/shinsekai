import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { fetchTopHeadlines, formatHeadlinesForClaude } from "./news.js";
import { sendToChat } from "./bot.js";
import { getUser } from "./db.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Your Telegram chat ID
const YOUR_CHAT_ID = process.env.MY_CHAT_ID || "985242254";

// Vietnam timezone = UTC+7
// Cron format: minute hour * * * (in UTC)
// 7am Vietnam = 0am UTC = "0 0 * * *"

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

    const prompt = `You are Hana, a Japanese tutor. It's 7am in Vietnam and you're sending your student their morning news briefing.

Here are today's top headlines:

${headlinesText}

Create a morning news digest message that:
1. Starts with a warm おはようございます greeting with today's energy
2. Covers ONE interesting story from last 24 hours for each of the following themes: Vietnam, Asian international affairs, global international affairs (exclude Asia), health, technology.
3. For each story:
   - Give the headline in Japanese first (translate it naturally)
   - Then explain it briefly in Japanese (2-3 sentences)
   - Pick TWO to THREE interesting vocabulary word from the Japanese headline and your translation, formatted as: 📚 word (reading) = meaning
   - Pick ONE use of grammar or pharase or tone that is interesting AND more advanced for the student level to explain to the student, formatted as: grammar form = meaning
4. End with a short encouraging line about the day ahead in a mix of Japanese and English

Student's Japanese level: ${level}
Keep Japanese complexity appropriate for their level but you can mix a little bit more advanced vocabulary or grammar.
Keep the whole message concise — this is a morning mobile message, not an essay.
Use emojis naturally to make it feel warm and readable.`;

    const response = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });

    const digest = response.content[0].text;
    await sendToChat(YOUR_CHAT_ID, digest);
    console.log("✅ Morning news digest sent!");

  } catch (err) {
    console.error("❌ News digest error:", err);
    await sendToChat(YOUR_CHAT_ID, "おはようございます！今朝はニュースの取得に問題がありました。ごめんなさい！");
  }
}

export function startScheduler() {
  // 7:00am Vietnam time (00:00 UTC) every day
  cron.schedule("0 0 * * *", async () => {
    console.log("⏰ 7am Vietnam — sending morning news digest");
    await generateNewsDigest();
  }, {
    timezone: "Asia/Ho_Chi_Minh",
  });

  console.log("✅ Scheduler started — news digest will run at 7:00am Vietnam time daily");
}

// Allow manual trigger via bot command
export { generateNewsDigest };
