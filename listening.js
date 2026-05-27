import Anthropic from "@anthropic-ai/sdk";
import { sendVoiceMessage } from "./tts.js";
import { fetchTopHeadlines, formatHeadlinesForClaude } from "./news.js";
import {
  getUser, db
} from "./db.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Daily life conversation scenarios — rotates to keep it fresh
const DAILY_SCENARIOS = [
  "two coworkers discussing plans for the weekend",
  "a customer ordering food at a restaurant",
  "a student asking a teacher about homework",
  "two friends deciding what movie to watch",
  "a parent and child discussing school",
  "someone calling to make a doctor's appointment",
  "two neighbours chatting about the weather",
  "a job interview for an office position",
  "friends planning a trip together",
  "a couple discussing what to cook for dinner",
  "a shopkeeper and customer haggling over price",
  "two colleagues discussing a work deadline",
];

// Pick a scenario based on day of month so it rotates
function getTodayScenario() {
  const day = new Date().getDate();
  return DAILY_SCENARIOS[day % DAILY_SCENARIOS.length];
}

// ── Generate daily life dialogue ──────────────────────
async function generateDailyDialogue(level) {
  const scenario = getTodayScenario();

  const prompt = `Generate a short Japanese dialogue for a listening comprehension exercise.

Scenario: ${scenario}
Student level: ${level} (N4-N3 range)
Duration: the dialogue should take about 20-30 seconds to read aloud naturally
Format: back-and-forth conversation between 2 people (label them A and B)
Language difficulty: natural but appropriate for ${level} level — use kanji with context clues

After the dialogue, generate ONE comprehension question about it.

Respond in JSON only, no markdown:
{
  "dialogue": "A: ...\nB: ...\nA: ...\nB: ...",
  "question": "the comprehension question in Japanese",
  "correct_answer": "a model correct answer in Japanese",
  "explanation": "brief explanation of the answer in Japanese (1-2 sentences)",
  "scenario_label": "short label eg. 職場での会話"
}`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = response.content[0].text.replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
}

// ── Generate news-based dialogue ─────────────────────
async function generateNewsDialogue(level) {
  const grouped = await fetchTopHeadlines();
  const headlinesText = formatHeadlinesForClaude(grouped);

  const prompt = `Generate a short Japanese listening comprehension dialogue based on a real news story.

Here are today's headlines to choose from:
${headlinesText}

Pick ONE interesting story and write a short dialogue or narration about it.
Student level: ${level} (N4-N3 range)
Duration: 30-40 seconds to read aloud naturally
Style: a single news anchor narration only — one speaker summarizing the story clearly
Language: natural N4-N3 Japanese

After the dialogue, generate ONE comprehension question about it.

Respond in JSON only, no markdown:
{
  "dialogue": "the dialogue or narration text in Japanese",
  "question": "comprehension question in Japanese",
  "correct_answer": "model correct answer in Japanese",
  "explanation": "brief explanation in Japanese (1-2 sentences)",
  "news_topic": "short label of the news topic eg. 経済ニュース"
}`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = response.content[0].text.replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
}

// ── Evaluate user's answer ────────────────────────────
async function evaluateAnswer(dialogue, question, correctAnswer, userAnswer) {
  const prompt = `You are Hana, a Japanese tutor. Evaluate this listening comprehension answer entirely in Japanese.

Dialogue the student listened to:
${dialogue}

Question asked: ${question}
Model answer: ${correctAnswer}
Student's answer: ${userAnswer}

Write feedback in Japanese that:
1. Says if the answer was correct or close (✅) or incorrect (❌)
2. Briefly explains the correct answer with reference to the dialogue
3. If incorrect, gently explains what they may have misheard or misunderstood
4. Ends with a short encouraging line

Keep it concise — 3-4 sentences maximum. Full Japanese only.`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  return response.content[0].text;
}

// ── Session state management ──────────────────────────
export function getListeningSession(chatId) {
  return db.prepare(
    "SELECT * FROM listening_sessions WHERE chat_id = ? AND state = 'active' ORDER BY started_at DESC LIMIT 1"
  ).get(chatId);
}

function createListeningSession(chatId, sessionData) {
  const result = db.prepare(
    `INSERT INTO listening_sessions (chat_id, session_data, current_part, state)
     VALUES (?, ?, 0, 'active')`
  ).run(chatId, JSON.stringify(sessionData));
  return result.lastInsertRowid;
}

function updateListeningSession(sessionId, data) {
  const fields = Object.keys(data).map(k => `${k} = ?`).join(", ");
  db.prepare(`UPDATE listening_sessions SET ${fields} WHERE id = ?`).run(...Object.values(data), sessionId);
}

export function endListeningSession(sessionId) {
  db.prepare(
    "UPDATE listening_sessions SET state = 'complete', ended_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(sessionId);
}

// ── Main session starter ──────────────────────────────
export async function startListeningSession(chatId, bot) {
  // Check for existing active session
  const existing = getListeningSession(chatId);
  if (existing) {
    await bot.sendMessage(chatId, "🎧 リスニングセッションがすでに進行中です！答えてから次に進みましょう。");
    return;
  }

  const user = getUser(chatId);
  const level = user?.japanese_level || "N4";

  await bot.sendMessage(chatId,
    "🌙 こんばんは！今夜のリスニング練習を始めましょう！\n\n2つのダイアローグを聞いて、質問に答えてください。準備はいいですか？ 🎧"
  );

  await new Promise(r => setTimeout(r, 2000));

  try {
    // Generate both dialogues upfront
    await bot.sendMessage(chatId, "ダイアローグを準備中です... 少々お待ちください 🎵");

    const [dailyDialogue, newsDialogue] = await Promise.all([
      generateDailyDialogue(level),
      generateNewsDialogue(level),
    ]);

    // Store session data
    const sessionData = { dailyDialogue, newsDialogue };
    const sessionId = createListeningSession(chatId, sessionData);

    // Send Part 1
    await sendPart1(chatId, bot, sessionId, dailyDialogue);

  } catch (err) {
    console.error("Listening session error:", err);
    await bot.sendMessage(chatId, "申し訳ありません！セッションの準備に問題がありました。もう一度試してください。🙏");
  }
}

// ── Send Part 1 (daily life dialogue) ────────────────
async function sendPart1(chatId, bot, sessionId, dialogue) {
  await bot.sendMessage(chatId, `🎭 *パート1: ${dialogue.scenario_label}*\n\n聞いてください 👂`, { parse_mode: "Markdown" });
  await new Promise(r => setTimeout(r, 1500));

  // Send dialogue as voice
  await sendVoiceMessage(bot, chatId, dialogue.dialogue, "dialogue1");
  await new Promise(r => setTimeout(r, 1500));

  // Send question as voice
  await bot.sendMessage(chatId, "❓ 質問：");
  await sendVoiceMessage(bot, chatId, dialogue.question, "question1");

  // Update session to waiting for part 1 answer
  updateListeningSession(sessionId, { current_part: 1 });
}

// ── Send Part 2 (news dialogue) ───────────────────────
async function sendPart2(chatId, bot, sessionId, dialogue) {
  await bot.sendMessage(chatId, `📰 *パート2: ${dialogue.news_topic}*\n\n聞いてください 👂`, { parse_mode: "Markdown" });
  await new Promise(r => setTimeout(r, 1500));

  await sendVoiceMessage(bot, chatId, dialogue.dialogue, "dialogue2");
  await new Promise(r => setTimeout(r, 1500));

  await bot.sendMessage(chatId, "❓ 質問：");
  await sendVoiceMessage(bot, chatId, dialogue.question, "question2");

  updateListeningSession(sessionId, { current_part: 2 });
}

// ── Handle user's answer ──────────────────────────────
export async function handleListeningAnswer(chatId, userAnswer, bot) {
  const session = getListeningSession(chatId);
  if (!session) return false; // not in a listening session

  const sessionData = JSON.parse(session.session_data);
  const { dailyDialogue, newsDialogue } = sessionData;

  if (session.current_part === 1) {
    // Evaluate part 1 answer
    const feedback = await evaluateAnswer(
      dailyDialogue.dialogue,
      dailyDialogue.question,
      dailyDialogue.correct_answer,
      userAnswer
    );
    await bot.sendMessage(chatId, feedback, { parse_mode: "Markdown" });

    // Move to part 2 after a pause
    await new Promise(r => setTimeout(r, 2000));
    await sendPart2(chatId, bot, session.id, newsDialogue);

  } else if (session.current_part === 2) {
    // Evaluate part 2 answer
    const feedback = await evaluateAnswer(
      newsDialogue.dialogue,
      newsDialogue.question,
      newsDialogue.correct_answer,
      userAnswer
    );
    await bot.sendMessage(chatId, feedback, { parse_mode: "Markdown" });

    // End session with closing voice message
    await new Promise(r => setTimeout(r, 2000));
    endListeningSession(session.id);

    const closing = "お疲れ様でした！今夜のリスニング練習が終わりました。よく頑張りましたね！また明日も一緒に練習しましょう。おやすみなさい。";
    await sendVoiceMessage(bot, chatId, closing, "closing");

    // Send transcript after closing
    await new Promise(r => setTimeout(r, 2000));
    const transcript = `📝 *今夜のトランスクリプト*\n\n` +
      `*🎭 パート1: ${dailyDialogue.scenario_label}*\n${dailyDialogue.dialogue}\n\n` +
      `❓ ${dailyDialogue.question}\n` +
      `✅ ${dailyDialogue.correct_answer}\n\n` +
      `*📰 パート2: ${newsDialogue.news_topic}*\n${newsDialogue.dialogue}\n\n` +
      `❓ ${newsDialogue.question}\n` +
      `✅ ${newsDialogue.correct_answer}`;
    await bot.sendMessage(chatId, transcript, { parse_mode: "Markdown" });
  }

  return true; // handled
}
