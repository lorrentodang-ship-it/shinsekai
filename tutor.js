import Anthropic from "@anthropic-ai/sdk";
import {
  getUser, createSession, getActiveSession, updateSession,
  endSession, logAnswer
} from "./db.js";
import { getSessionVocab, buildVocabPromptSection } from "./vocab_picker.js";
import { updateWordAfterReview, getN3Words, introduceWord } from "./srs.js";
import {
  getTodaysGrammarSession, updateGrammarAfterReview,
  buildGrammarPromptSection
} from "./grammar_srs.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Fallback grammar patterns if DB is empty/unseeded
const FALLBACK_GRAMMAR = [
  { pattern: "〜ために", meaning: "in order to / because of" },
  { pattern: "〜ように", meaning: "so that / in order to" },
  { pattern: "〜てしまう", meaning: "end up doing / unfortunately did" },
  { pattern: "〜ておく", meaning: "do in advance / leave as is" },
  { pattern: "〜はずだ", meaning: "should be / is expected to" },
  { pattern: "〜らしい", meaning: "seems like / apparently" },
  { pattern: "〜によって", meaning: "by / depending on / due to" },
  { pattern: "〜ことになる", meaning: "it has been decided / will end up" },
];

// ── Safe JSON parse ───────────────────────────────────
function safeParseQuestions(text, fallbackType = "vocab") {
  try {
    const raw = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Not an array");
    return parsed.map(q => ({
      type: q.type || fallbackType,
      question: q.question || "Question unavailable",
      answer: q.answer || "",
      hint: (q.hint && q.hint !== "undefined" && q.hint !== "null") ? q.hint : null,
      vocab_word: q.vocab_word || null,
      vocab_reading: q.vocab_reading || "",
      vocab_meaning: q.vocab_meaning || null,
      vocab_id: q.vocab_id || null,
      grammar_id: q.grammar_id || null,
      choices: q.choices || null,
    }));
  } catch (err) {
    console.error(`Failed to parse ${fallbackType} questions:`, err.message);
    console.error("Raw response:", text?.slice(0, 300));
    return null;
  }
}

// ═══════════════════════════════════════════════════════
// VOCAB SESSION (/practice) — 12 questions
// ═══════════════════════════════════════════════════════

async function generateVocabPart1(chatId, level) {
  const sessionVocab = getSessionVocab(chatId);
  const vocabSection = buildVocabPromptSection(sessionVocab);

  const prompt = `You are Hana, a Japanese tutor. Generate exactly 7 vocabulary questions for a JLPT ${level} student.

${vocabSection}

Use ONLY the words listed above. Mix these question types:
- Fill in the blank
- Choose the correct particle
- Translate a short phrase
- Verb conjugation

Return a JSON array only — no markdown, no preamble:
[
  {
    "type": "fill_blank",
    "question": "question text",
    "answer": "correct answer",
    "hint": "REQUIRED: short clue about the answer",
    "vocab_word": "word being tested",
    "vocab_reading": "hiragana reading",
    "vocab_meaning": "English meaning",
    "vocab_id": 42,
    "grammar_id": null
  }
]
RULES: hint is required on every question. vocab_id must match the word list. grammar_id must be null.`;

  const res = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });
  return safeParseQuestions(res.content[0].text, "vocab");
}

async function generateVocabPart2(chatId, level) {
  const n3Words = getN3Words(chatId, 5);
  for (const w of n3Words) {
    if (!w.vocab_id) introduceWord(chatId, w.id);
  }

  const wordList = n3Words.length > 0
    ? n3Words.map((w, i) =>
        `${i + 1}. [id:${w.vocab_id || w.id}] ${w.word} (${w.reading}) = ${w.meaning}`
      ).join("\n")
    : "Use common N3 vocabulary like 決める、上昇、予報、確認、状況.";

  const prompt = `Generate exactly 5 challenging N3 vocabulary questions for a ${level} student.

N3 words to use:
${wordList}

Make questions more challenging:
- Sentence construction using the word naturally
- Choose the correct word for a nuanced sentence
- Use the word in context with N3-level grammar

Return a JSON array only — no markdown:
[
  {
    "type": "fill_blank",
    "question": "question text",
    "answer": "correct answer",
    "hint": "REQUIRED: short clue — never empty",
    "vocab_word": "word being tested",
    "vocab_reading": "reading",
    "vocab_meaning": "meaning",
    "vocab_id": 123,
    "grammar_id": null
  }
]
RULES: hint required on every question. vocab_id must match [id:X] from the list. grammar_id must be null.`;

  const res = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });
  return safeParseQuestions(res.content[0].text, "vocab");
}

// ── Start vocab session ───────────────────────────────
export async function startVocabSession(chatId, sendFn) {
  const existing = getActiveSession(chatId);
  if (existing) {
    await sendFn(chatId,
      "✏️ You already have an active session! Answer the current question or send /skipsession to start fresh."
    );
    return;
  }

  await sendFn(chatId, "📚 Starting vocab session — generating questions...");

  const user = getUser(chatId);
  const level = user?.japanese_level || "N4";

  try {
    await sendFn(chatId, "📚 *Part 1: Vocabulary Review* (Questions 1-7)");
    await new Promise(r => setTimeout(r, 500));

    const part1 = await generateVocabPart1(chatId, level);
    if (!part1 || part1.length === 0) {
      await sendFn(chatId, "❌ Could not generate vocab questions. Try /practice again.");
      return;
    }

    // Create session with part1, will load part2 at boundary
    const sessionId = createSession(chatId, part1, 12);
    await sendVocabQuestion(chatId, sessionId, part1, 0, sendFn);

  } catch (err) {
    console.error("Vocab session error:", err);
    await sendFn(chatId, "申し訳ありません！Something went wrong. Try /practice again 🙏");
  }
}

async function sendVocabQuestion(chatId, sessionId, questions, index, sendFn) {
  const q = questions[index];
  if (!q) return;

  const total = 12;
  const safeQuestion = q.question.replace(/_/g, "\\_");
  let message = `📝 *Question (${index + 1}/${total})*\n\n${safeQuestion}`;

  if (q.type === "multiple_choice" && q.choices) {
    message += "\n\n" + q.choices.map((c, i) => `${["A", "B", "C", "D"][i]}) ${c}`).join("\n");
  }
  if (q.hint) message += `\n\n💡 _Hint: ${q.hint}_`;

  await sendFn(chatId, message);
  updateSession(sessionId, { current_question: index });
}

export async function handleVocabAnswer(chatId, userAnswer, sendFn) {
  const session = getActiveSession(chatId);
  if (!session || session.session_type !== "vocab") return false;

  const questions = JSON.parse(session.questions_json);
  const currentIndex = session.current_question;
  const q = questions[currentIndex];

  const evaluation = await evaluateAnswer(q, userAnswer);
  const wasCorrect = evaluation.correct;

  logAnswer(session.id, chatId, q.question, q.answer, userAnswer, wasCorrect);
  if (q.vocab_id) updateWordAfterReview(chatId, q.vocab_id, wasCorrect);

  updateSession(session.id, {
    correct: session.correct + (wasCorrect ? 1 : 0),
    incorrect: session.incorrect + (wasCorrect ? 0 : 1),
  });

  await sendFn(chatId, buildFeedback(q, evaluation));

  const nextIndex = currentIndex + 1;
  const user = getUser(chatId);
  const level = user?.japanese_level || "N4";

  setTimeout(async () => {
    // Load part 2 at boundary
    if (nextIndex === 7 && questions.length === 7) {
      await sendFn(chatId, "📗 *Part 2: N3 Vocabulary* (Questions 8-12)\n\n_Generating..._");
      try {
        const part2 = await generateVocabPart2(chatId, level);
        if (!part2 || part2.length === 0) throw new Error("Empty response");
        const updated = [...questions, ...part2];
        updateSession(session.id, { questions_json: JSON.stringify(updated) });
        await new Promise(r => setTimeout(r, 500));
        await sendVocabQuestion(chatId, session.id, updated, 7, sendFn);
      } catch (err) {
        console.error("Part 2 load error:", err.message);
        await sendFn(chatId, "⚠️ Could not load N3 vocab questions. Finishing session.");
        finishVocabSession(chatId, session, sendFn);
      }
    } else if (nextIndex < questions.length) {
      await sendVocabQuestion(chatId, session.id, questions, nextIndex, sendFn);
    } else {
      finishVocabSession(chatId, session, sendFn);
    }
  }, 1500);

  return true;
}

async function finishVocabSession(chatId, session, sendFn) {
  endSession(session.id);
  const total = session.total_questions;
  const correct = session.correct + 1;
  const score = Math.round((correct / total) * 100);
  const emoji = score >= 80 ? "🌟" : score >= 60 ? "👍" : "💪";

  await sendFn(chatId, `${emoji} *Vocab Session Complete!*

📊 Score: ${correct}/${total} (${score}%)

${score >= 80 ? "素晴らしい！ 🎉" : "Keep practicing! 復習しましょう！"}
\nReady for grammar? Try /grammar 📝`);
}

// ═══════════════════════════════════════════════════════
// GRAMMAR SESSION (/grammar) — 8 questions
// ═══════════════════════════════════════════════════════

async function generateGrammarQuestions(chatId, level) {
  let grammarSection = "";
  try {
    const grammarSession = getTodaysGrammarSession(chatId);
    grammarSection = buildGrammarPromptSection(grammarSession);
    console.log("✅ Grammar session loaded from DB");
  } catch (err) {
    console.warn("⚠️ Grammar DB unavailable, using fallback:", err.message);
    grammarSection = "NEW PATTERNS (introduce today):\n" +
      FALLBACK_GRAMMAR.map((g, i) =>
        `${i + 1}. ${g.pattern} = ${g.meaning}\n   → Write a Level 1 RECOGNITION question`
      ).join("\n");
  }

  const prompt = `Generate exactly 8 N3 grammar questions for a ${level} student.

${grammarSection}

Question level guide:
- Level 1 RECOGNITION: Multiple choice — pick the correct grammar pattern
- Level 2 PRODUCTION: Fill in blank — write the correct grammar form
- Level 3 NUANCE: Write own sentence OR explain difference from similar pattern

Return a JSON array only — no markdown:
[
  {
    "type": "grammar",
    "question": "question text with clear context",
    "answer": "correct answer",
    "hint": "REQUIRED: the grammar pattern being tested e.g. 〜ために",
    "vocab_word": "grammar pattern e.g. 〜ために",
    "vocab_reading": "",
    "vocab_meaning": "meaning of the pattern",
    "vocab_id": null,
    "grammar_id": null
  }
]
RULES: hint is required on every question. vocab_id must always be null. Return exactly 8 questions.`;

  const res = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 2500,
    messages: [{ role: "user", content: prompt }],
  });
  return safeParseQuestions(res.content[0].text, "grammar");
}

// ── Start grammar session ─────────────────────────────
export async function startGrammarSession(chatId, sendFn) {
  const existing = getActiveSession(chatId);
  if (existing) {
    await sendFn(chatId,
      "✏️ You already have an active session! Answer the current question or send /skipsession to start fresh."
    );
    return;
  }

  await sendFn(chatId, "📝 Starting grammar session — generating questions...");

  const user = getUser(chatId);
  const level = user?.japanese_level || "N4";

  try {
    const grammarQs = await generateGrammarQuestions(chatId, level);
    if (!grammarQs || grammarQs.length === 0) {
      await sendFn(chatId, "❌ Could not generate grammar questions. Try /grammar again.");
      return;
    }

    const sessionId = createSession(chatId, grammarQs, grammarQs.length, "grammar");
    await sendGrammarQuestion(chatId, sessionId, grammarQs, 0, sendFn);

  } catch (err) {
    console.error("Grammar session error:", err);
    await sendFn(chatId, "申し訳ありません！Something went wrong. Try /grammar again 🙏");
  }
}

async function sendGrammarQuestion(chatId, sessionId, questions, index, sendFn) {
  const q = questions[index];
  if (!q) return;

  const total = questions.length;
  const safeQuestion = q.question.replace(/_/g, "\\_");
  let message = `📝 *Grammar Question (${index + 1}/${total})*\n\n${safeQuestion}`;

  if (q.type === "multiple_choice" && q.choices) {
    message += "\n\n" + q.choices.map((c, i) => `${["A", "B", "C", "D"][i]}) ${c}`).join("\n");
  }
  if (q.hint) message += `\n\n💡 _Pattern: ${q.hint}_`;

  await sendFn(chatId, message);
  updateSession(sessionId, { current_question: index });
}

export async function handleGrammarAnswer(chatId, userAnswer, sendFn) {
  const session = getActiveSession(chatId);
  if (!session || session.session_type !== "grammar") return false;

  const questions = JSON.parse(session.questions_json);
  const currentIndex = session.current_question;
  const q = questions[currentIndex];

  const evaluation = await evaluateAnswer(q, userAnswer);
  const wasCorrect = evaluation.correct;

  logAnswer(session.id, chatId, q.question, q.answer, userAnswer, wasCorrect);
  if (q.grammar_id) updateGrammarAfterReview(chatId, q.grammar_id, wasCorrect);

  updateSession(session.id, {
    correct: session.correct + (wasCorrect ? 1 : 0),
    incorrect: session.incorrect + (wasCorrect ? 0 : 1),
  });

  await sendFn(chatId, buildFeedback(q, evaluation));

  const nextIndex = currentIndex + 1;
  setTimeout(async () => {
    if (nextIndex < questions.length) {
      await sendGrammarQuestion(chatId, session.id, questions, nextIndex, sendFn);
    } else {
      finishGrammarSession(chatId, session, sendFn);
    }
  }, 1500);

  return true;
}

async function finishGrammarSession(chatId, session, sendFn) {
  endSession(session.id);
  const total = session.total_questions;
  const correct = session.correct + 1;
  const score = Math.round((correct / total) * 100);
  const emoji = score >= 80 ? "🌟" : score >= 60 ? "👍" : "💪";

  await sendFn(chatId, `${emoji} *Grammar Session Complete!*

📊 Score: ${correct}/${total} (${score}%)

${score >= 80 ? "文法が上手になってきた！🎉" : "文法を続けて練習しましょう！💪"}`);
}

// ═══════════════════════════════════════════════════════
// SHARED HELPERS
// ═══════════════════════════════════════════════════════

async function evaluateAnswer(q, userAnswer) {
  try {
    const evalPrompt = `A Japanese student answered a question. Determine if their answer is correct.

Question: ${q.question}
Expected answer: ${q.answer}
Student's answer: ${userAnswer}
Question type: ${q.type}

Be lenient — accept correct meaning even if formatting differs slightly.
Accept reasonable romaji for Japanese answers.
For grammar questions, accept answers that demonstrate understanding of the pattern.

Reply with JSON only:
{"correct": true/false, "explanation": "brief feedback in 1 sentence", "correct_form": "${q.answer}"}`;

    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{ role: "user", content: evalPrompt }],
    });

    const raw = res.content[0].text.replace(/```json|```/g, "").trim();
    return JSON.parse(raw);
  } catch {
    return { correct: false, explanation: "Could not evaluate.", correct_form: q.answer };
  }
}

function buildFeedback(q, evaluation) {
  let feedback = evaluation.correct
    ? `✅ *正解！* ${evaluation.explanation}`
    : `❌ *Not quite!*\n${evaluation.explanation}\n✏️ Correct: *${q.answer}*`;

  if (q.vocab_word) {
    const reading = q.vocab_reading ? ` (${q.vocab_reading})` : "";
    feedback += `\n\n📚 ${q.vocab_word}${reading} = ${q.vocab_meaning}`;
  }
  return feedback;
}

// ── Legacy exports for backward compatibility ─────────
// These allow bot.js to keep using the old function names
// while routing to the new separate sessions

export async function startTutorSession(chatId, sendFn) {
  return startVocabSession(chatId, sendFn);
}

export async function handleSessionAnswer(chatId, userAnswer, sendFn) {
  // Try vocab session first, then grammar session
  const session = getActiveSession(chatId);
  if (!session) return false;
  if (session.session_type === "grammar") {
    return handleGrammarAnswer(chatId, userAnswer, sendFn);
  }
  return handleVocabAnswer(chatId, userAnswer, sendFn);
}

export function skipSession(chatId) {
  const session = getActiveSession(chatId);
  if (session) {
    endSession(session.id);
    return true;
  }
  return false;
}
