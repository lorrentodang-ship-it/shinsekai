import Anthropic from "@anthropic-ai/sdk";
import {
  getUser, createSession, getActiveSession, updateSession,
  endSession, logAnswer
} from "./db.js";
import { getSessionVocab, buildVocabPromptSection, getN3OnlyVocab } from "./vocab_picker.js";
import { updateWordAfterReview, getN3Words, introduceWord } from "./srs.js";
import {
  getTodaysGrammarSession, updateGrammarAfterReview,
  buildGrammarPromptSection
} from "./grammar_srs.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Generate all 20 questions (3 parallel Claude calls) ──
async function generateQuestions(chatId) {
  const user = getUser(chatId);
  const level = user?.japanese_level || "N4";

  // ── Vocab Part 1: SRS words (questions 1-7) ──────────
  const sessionVocab = getSessionVocab(chatId);
  const vocabSection = buildVocabPromptSection(sessionVocab);

  const vocabPrompt = `You are Hana, a Japanese tutor. Generate 7 vocabulary questions for a JLPT ${level} student.

${vocabSection}

Create exactly 7 questions using ONLY the words listed. Mix these types:
- Fill in the blank
- Choose the correct particle
- Translate a short phrase
- Verb conjugation

JSON array only — no markdown:
[
  {
    "type": "fill_blank",
    "question": "question text",
    "answer": "correct answer",
    "hint": "hint text",
    "vocab_word": "word",
    "vocab_reading": "reading",
    "vocab_meaning": "meaning",
    "vocab_id": 42,
    "grammar_id": null
  }
]
Every question MUST have vocab_id (from word list) and grammar_id: null.`;

  // ── Vocab Part 2: N3-only vocab (questions 8-12) ─────
  const n3Words = getN3Words(chatId, 5);
  for (const w of n3Words) {
    if (!w.vocab_id) introduceWord(chatId, w.id);
  }

  const n3WordList = n3Words.length > 0
    ? n3Words.map((w, i) =>
        `${i + 1}. [id:${w.vocab_id || w.id}] ${w.word} (${w.reading}) = ${w.meaning} [N3]`
      ).join("\n")
    : "No N3 words available yet — use common N3 vocabulary.";

  const n3VocabPrompt = `Generate exactly 5 N3-focused vocabulary questions. Use ONLY these N3 words:
${n3WordList}

Make questions more challenging:
- Sentence construction using the word naturally
- Choose the correct word for a nuanced sentence
- Use the word in context with N3-level grammar

JSON array only — same structure, vocab_id must match the [id:X] from the list, grammar_id: null.`;

  // ── Grammar: 8 questions (questions 13-20) ────────────
  const grammarSession = getTodaysGrammarSession(chatId);
  const grammarSection = buildGrammarPromptSection(grammarSession);

  const grammarPrompt = `Generate exactly 8 N3 grammar questions for a ${level} student.

${grammarSection}

Question level guide:
- Level 1 RECOGNITION: Multiple choice — pick the correct grammar pattern to complete the sentence
- Level 2 PRODUCTION: Fill in blank — write the correct grammar form
- Level 3 NUANCE: Write your own sentence OR explain the difference from a similar pattern

JSON array only — no markdown:
[
  {
    "type": "grammar",
    "question": "question text",
    "answer": "correct answer",
    "hint": "the grammar pattern being tested",
    "vocab_word": "grammar pattern eg 〜ために",
    "vocab_reading": "",
    "vocab_meaning": "meaning of the pattern",
    "vocab_id": null,
    "grammar_id": 5
  }
]
grammar_id MUST match the grammar pattern's database id (use the number after 'id:' if shown, otherwise set null).
vocab_id must be null for grammar questions.`;

  // ── Fire all three in parallel ────────────────────────
  const [vocabRes, n3VocabRes, grammarRes] = await Promise.all([
    client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 2000,
      messages: [{ role: "user", content: vocabPrompt }],
    }),
    client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1500,
      messages: [{ role: "user", content: n3VocabPrompt }],
    }),
    client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 2000,
      messages: [{ role: "user", content: grammarPrompt }],
    }),
  ]);

  const vocabQs = JSON.parse(vocabRes.content[0].text.replace(/```json|```/g, "").trim());
  const n3VocabQs = JSON.parse(n3VocabRes.content[0].text.replace(/```json|```/g, "").trim());
  const grammarQs = JSON.parse(grammarRes.content[0].text.replace(/```json|```/g, "").trim());

  return [...vocabQs, ...n3VocabQs, ...grammarQs];
}

// ── Start a new session ───────────────────────────────
export async function startTutorSession(chatId, sendFn) {
  const existing = getActiveSession(chatId);
  if (existing) {
    await sendFn(chatId,
      "✏️ You already have an active session! Answer the current question or send /skipsession to start fresh."
    );
    return;
  }

  await sendFn(chatId, "✏️ Generating your 20-question session — vocab + N3 grammar... just a moment!");

  try {
    const questions = await generateQuestions(chatId);
    const sessionId = createSession(chatId, questions, questions.length);

    // Section announcements
    const sectionBreaks = {
      0: "📚 *Part 1: Vocabulary Review* (Questions 1-7)",
      7: "📗 *Part 2: N3 Vocabulary* (Questions 8-12)",
      12: "📝 *Part 3: N3 Grammar* (Questions 13-20)",
    };

    if (sectionBreaks[0]) {
      await sendFn(chatId, sectionBreaks[0]);
      await new Promise(r => setTimeout(r, 800));
    }

    await sendQuestion(chatId, sessionId, questions, 0, sendFn, sectionBreaks);

  } catch (err) {
    console.error("Session generation error:", err);
    await sendFn(chatId, "申し訳ありません！Something went wrong. Try again with /practice 🙏");
  }
}

// ── Send a question ───────────────────────────────────
async function sendQuestion(chatId, sessionId, questions, index, sendFn, sectionBreaks = {}) {
  const q = questions[index];
  const total = questions.length;

  let message = `📝 *Question (${index + 1}/${total})*\n\n${q.question}`;
  if (q.type === "multiple_choice" && q.choices) {
    message += "\n\n" + q.choices.map((c, i) => `${["A", "B", "C", "D"][i]}) ${c}`).join("\n");
  }
  message += `\n\n💡 _Hint: ${q.hint}_`;

  await sendFn(chatId, message);
  updateSession(sessionId, { current_question: index });
}

// ── Handle a user's answer ────────────────────────────
export async function handleSessionAnswer(chatId, userAnswer, sendFn) {
  const session = getActiveSession(chatId);
  if (!session) return false;

  const questions = JSON.parse(session.questions_json);
  const currentIndex = session.current_question;
  const q = questions[currentIndex];

  const evalPrompt = `A Japanese student answered a question. Determine if their answer is correct.

Question: ${q.question}
Expected answer: ${q.answer}
Student's answer: ${userAnswer}
Question type: ${q.type}

Be lenient — accept correct meaning even if formatting differs slightly.
Accept reasonable romaji for Japanese answers.
For grammar questions, accept answers that demonstrate understanding of the pattern even if wording differs.

Reply with JSON only:
{"correct": true/false, "explanation": "brief feedback in 1 sentence", "correct_form": "${q.answer}"}`;

  const evalResponse = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 200,
    messages: [{ role: "user", content: evalPrompt }],
  });

  let evaluation;
  try {
    const raw = evalResponse.content[0].text.replace(/```json|```/g, "").trim();
    evaluation = JSON.parse(raw);
  } catch {
    evaluation = { correct: false, explanation: "Could not evaluate.", correct_form: q.answer };
  }

  const wasCorrect = evaluation.correct;

  logAnswer(session.id, chatId, q.question, q.answer, userAnswer, wasCorrect);

  // Route SRS update — vocab or grammar
  if (q.vocab_id) {
    updateWordAfterReview(chatId, q.vocab_id, wasCorrect);
  } else if (q.grammar_id) {
    updateGrammarAfterReview(chatId, q.grammar_id, wasCorrect);
  }

  updateSession(session.id, {
    correct: session.correct + (wasCorrect ? 1 : 0),
    incorrect: session.incorrect + (wasCorrect ? 0 : 1),
  });

  // Build feedback
  let feedback = wasCorrect
    ? `✅ *正解！* ${evaluation.explanation}`
    : `❌ *Not quite!*\n${evaluation.explanation}\n✏️ Correct: *${q.answer}*`;

  if (q.vocab_word) {
    const reading = q.vocab_reading ? ` (${q.vocab_reading})` : "";
    feedback += `\n\n📚 ${q.vocab_word}${reading} = ${q.vocab_meaning}`;
  }

  await sendFn(chatId, feedback);

  // Section break announcements
  const sectionBreaks = {
    7: "📗 *Part 2: N3 Vocabulary* (Questions 8-12)",
    12: "📝 *Part 3: N3 Grammar* (Questions 13-20)",
  };

  const nextIndex = currentIndex + 1;
  if (nextIndex < questions.length) {
    const announcement = sectionBreaks[nextIndex];
    setTimeout(async () => {
      if (announcement) {
        await sendFn(chatId, announcement);
        await new Promise(r => setTimeout(r, 800));
      }
      await sendQuestion(chatId, session.id, questions, nextIndex, sendFn);
    }, 1500);
  } else {
    setTimeout(() => finishSession(chatId, session, sendFn), 1500);
  }

  return true;
}

// ── Finish session with summary ───────────────────────
async function finishSession(chatId, session, sendFn) {
  endSession(session.id);

  const total = session.total_questions;
  const correct = session.correct + 1;
  const incorrect = total - correct;
  const score = Math.round((correct / total) * 100);

  const emoji = score >= 80 ? "🌟" : score >= 60 ? "👍" : "💪";
  const verdict = score >= 80 ? "Excellent work!" : score >= 60 ? "Good effort!" : "Keep practicing!";

  const summary = `${emoji} *Session Complete!*

📊 Score: ${correct}/${total} (${score}%)
✅ Correct: ${correct}  ❌ Incorrect: ${incorrect}

${verdict}
${score < 80 ? "\nI'll bring back the tricky ones next session. 復習しましょう！" : "\n素晴らしい！Keep up the great work! 🎉"}`;

  await sendFn(chatId, summary);
}

// ── Skip current session ──────────────────────────────
export function skipSession(chatId) {
  const session = getActiveSession(chatId);
  if (session) {
    endSession(session.id);
    return true;
  }
  return false;
}
