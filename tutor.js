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

// ── Safe JSON parse with fallback ─────────────────────
function safeParseQuestions(text, expectedCount, fallbackType = "vocab") {
  try {
    const raw = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Not an array");
    // Sanitize each question — fill in missing fields with safe defaults
    return parsed.map(q => ({
      type: q.type || fallbackType,
      question: q.question || "Question unavailable",
      answer: q.answer || "",
      hint: (q.hint && q.hint !== "undefined" && q.hint !== "null") ? q.hint : null,
      vocab_word: q.vocab_word || null,
      vocab_reading: q.vocab_reading || null,
      vocab_meaning: q.vocab_meaning || null,
      vocab_id: q.vocab_id || null,
      grammar_id: q.grammar_id || null,
      choices: q.choices || null,
    }));
  } catch (err) {
    console.error(`Failed to parse questions (expected ${expectedCount}):`, err.message);
    return null;
  }
}

// ── Generate Part 1: SRS vocab questions (1-7) ───────
async function generateVocabQuestions(chatId, level) {
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
    "question": "question text in Japanese with English hint in brackets",
    "answer": "correct answer",
    "hint": "REQUIRED: short clue about the answer",
    "vocab_word": "the word being tested",
    "vocab_reading": "reading in hiragana",
    "vocab_meaning": "English meaning",
    "vocab_id": 42,
    "grammar_id": null
  }
]
RULES: Every field is required. hint must never be empty, null, or undefined. vocab_id must match the word list. grammar_id must be null.`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });

  return safeParseQuestions(response.content[0].text, 7, "vocab");
}

// ── Generate Part 2: N3 vocab questions (8-12) ───────
async function generateN3VocabQuestions(chatId, level) {
  const n3Words = getN3Words(chatId, 5);
  for (const w of n3Words) {
    if (!w.vocab_id) introduceWord(chatId, w.id);
  }

  const wordList = n3Words.length > 0
    ? n3Words.map((w, i) =>
        `${i + 1}. [id:${w.vocab_id || w.id}] ${w.word} (${w.reading}) = ${w.meaning}`
      ).join("\n")
    : "No N3 words yet — use common N3 vocabulary like 決める、上昇、予報.";

  const prompt = `Generate exactly 5 challenging N3 vocabulary questions for a ${level} student.

N3 words to use:
${wordList}

Make questions more challenging than Part 1:
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
RULES: hint is required on every question. vocab_id must match [id:X] from the list above. grammar_id must be null.`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  return safeParseQuestions(response.content[0].text, 5, "vocab");
}

// ── Generate Part 3: N3 grammar questions (13-20) ────
async function generateGrammarQuestions(chatId, level) {
  const grammarSession = getTodaysGrammarSession(chatId);
  const grammarSection = buildGrammarPromptSection(grammarSession);

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
    "hint": "REQUIRED: name the grammar pattern being tested, e.g. 〜ために",
    "vocab_word": "grammar pattern e.g. 〜ために",
    "vocab_reading": "",
    "vocab_meaning": "meaning of the pattern",
    "vocab_id": null,
    "grammar_id": 5
  }
]
RULES: hint is required on every question — use the grammar pattern name as the hint. vocab_id must be null. grammar_id should match the pattern id if known.`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });

  return safeParseQuestions(response.content[0].text, 8, "grammar");
}

// ── Start a new session (sequential generation) ───────
export async function startTutorSession(chatId, sendFn) {
  const existing = getActiveSession(chatId);
  if (existing) {
    await sendFn(chatId,
      "✏️ You already have an active session! Answer the current question or send /skipsession to start fresh."
    );
    return;
  }

  await sendFn(chatId, "✏️ Starting your session — generating questions...");

  const user = getUser(chatId);
  const level = user?.japanese_level || "N4";

  try {
    // ── Part 1: Vocab (sequential, not parallel) ──────
    await sendFn(chatId, "📚 *Part 1: Vocabulary Review* (Questions 1-7)");
    await new Promise(r => setTimeout(r, 500));

    const vocabQs = await generateVocabQuestions(chatId, level);
    if (!vocabQs || vocabQs.length === 0) {
      await sendFn(chatId, "❌ Could not generate vocabulary questions. Try /practice again.");
      return;
    }

    // Create session with just vocab questions first
    const allQuestions = [...vocabQs];
    const sessionId = createSession(chatId, allQuestions, 20); // reserve 20 total
    await sendQuestion(chatId, sessionId, allQuestions, 0, sendFn);

  } catch (err) {
    console.error("Session start error:", err);
    await sendFn(chatId, "申し訳ありません！Something went wrong. Try again with /practice 🙏");
  }
}

// ── Load next section into session ───────────────────
async function loadNextSection(chatId, sessionId, currentQuestions, sendFn) {
  const user = getUser(chatId);
  const level = user?.japanese_level || "N4";
  const count = currentQuestions.length;

  try {
    if (count === 7) {
      // Load Part 2: N3 vocab
      await sendFn(chatId, "📗 *Part 2: N3 Vocabulary* (Questions 8-12)\n\n_Generating questions..._");
      const n3Qs = await generateN3VocabQuestions(chatId, level);
      if (!n3Qs || n3Qs.length === 0) {
        await sendFn(chatId, "⚠️ Could not load N3 vocabulary questions. Skipping to grammar...");
        return loadNextSection(chatId, sessionId, [...currentQuestions, ...[]], sendFn);
      }
      const updated = [...currentQuestions, ...n3Qs];
      updateSession(sessionId, { questions_json: JSON.stringify(updated) });
      await new Promise(r => setTimeout(r, 500));
      await sendQuestion(chatId, sessionId, updated, 7, sendFn);

    } else if (count === 12) {
      // Load Part 3: Grammar
      await sendFn(chatId, "📝 *Part 3: N3 Grammar* (Questions 13-20)\n\n_Generating questions..._");
      const grammarQs = await generateGrammarQuestions(chatId, level);
      if (!grammarQs || grammarQs.length === 0) {
        await sendFn(chatId, "⚠️ Could not load grammar questions. Session ending early.");
        const fakeSession = { id: sessionId, total_questions: count, correct: 0, incorrect: 0 };
        await finishSession(chatId, fakeSession, sendFn);
        return;
      }
      const updated = [...currentQuestions, ...grammarQs];
      updateSession(sessionId, { questions_json: JSON.stringify(updated) });
      await new Promise(r => setTimeout(r, 500));
      await sendQuestion(chatId, sessionId, updated, 12, sendFn);
    }
  } catch (err) {
    console.error("Section load error:", err);
    await sendFn(chatId, "⚠️ Could not load next section. Your progress so far has been saved.");
  }
}

// ── Send a question ───────────────────────────────────
async function sendQuestion(chatId, sessionId, questions, index, sendFn) {
  const q = questions[index];
  const total = 20; // always show out of 20

  let message = `📝 *Question (${index + 1}/${total})*\n\n${q.question}`;

  if (q.type === "multiple_choice" && q.choices) {
    message += "\n\n" + q.choices.map((c, i) => `${["A", "B", "C", "D"][i]}) ${c}`).join("\n");
  }

  if (q.hint) {
    message += `\n\n💡 _Hint: ${q.hint}_`;
  }

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

  const nextIndex = currentIndex + 1;

  // Check if we need to load the next section
  const sectionBoundaries = [7, 12];
  const needsNextSection = sectionBoundaries.includes(nextIndex) &&
    nextIndex >= questions.length;

  setTimeout(async () => {
    if (needsNextSection) {
      // Load next section questions then continue
      await loadNextSection(chatId, session.id, questions, sendFn);
    } else if (nextIndex < questions.length) {
      await sendQuestion(chatId, session.id, questions, nextIndex, sendFn);
    } else if (nextIndex < 20 && questions.length < 20) {
      // Edge case: we're at end of loaded questions but not at 20 yet
      await loadNextSection(chatId, session.id, questions, sendFn);
    } else {
      // All 20 done
      finishSession(chatId, session, sendFn);
    }
  }, 1500);

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
