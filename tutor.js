import Anthropic from "@anthropic-ai/sdk";
import {
  getUser, createSession, getActiveSession, updateSession,
  endSession, logAnswer
} from "./db.js";
import { getSessionVocab, buildVocabPromptSection } from "./vocab_picker.js";
import { updateWordAfterReview } from "./srs.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Generate a full set of questions ─────────────────
async function generateQuestions(chatId) {
  const user = getUser(chatId);
  const level = user?.japanese_level || "N4";

  // Get today's vocab from the SRS database
  const sessionVocab = getSessionVocab(chatId);
  const vocabSection = buildVocabPromptSection(sessionVocab);

  const prompt = `You are Hana, a Japanese tutor. Generate a tutoring session for a student at JLPT level ${level}.

${vocabSection}

Create exactly 8 questions that mix vocabulary and grammar. Use a variety of question types:
- Fill in the blank (vocabulary) — use the specific words listed above
- Choose the correct particle (grammar)
- Translate a short phrase using today's vocab
- Conjugate a verb from today's list (grammar)
- Sentence construction using today's words

Format your response as a JSON array only — no preamble, no markdown, just the raw JSON:
[
  {
    "type": "fill_blank",
    "question": "毎日野菜を______います。(I eat vegetables every day)",
    "answer": "食べて",
    "hint": "verb: to eat, te-form",
    "vocab_word": "食べる",
    "vocab_reading": "たべる",
    "vocab_meaning": "to eat",
    "vocab_id": 42
  }
]

Each question MUST have: type, question, answer, hint, vocab_word, vocab_reading, vocab_meaning, vocab_id.
The vocab_id must match the id from the word list above.
Keep questions appropriate for ${level} level. Make them feel natural and useful for daily life.`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = response.content[0].text.replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
}

// ── Start a new session ───────────────────────────────
export async function startTutorSession(chatId, sendFn) {
  // Check if session already active
  const existing = getActiveSession(chatId);
  if (existing) {
    await sendFn(chatId,
      "✏️ You already have an active session! Answer the current question or send /skipsession to start fresh."
    );
    return;
  }

  await sendFn(chatId, "✏️ Generating your session... just a moment!");

  try {
    const questions = await generateQuestions(chatId);
    const sessionId = createSession(chatId, questions, questions.length);

    // Send the first question
    await sendQuestion(chatId, sessionId, questions, 0, sendFn);

  } catch (err) {
    console.error("Session generation error:", err);
    await sendFn(chatId, "申し訳ありません！Something went wrong generating your session. Try again with /practice 🙏");
  }
}

// ── Send a question ───────────────────────────────────
async function sendQuestion(chatId, sessionId, questions, index, sendFn) {
  const q = questions[index];
  const total = questions.length;
  const progress = `(${index + 1}/${total})`;

  let message = `📝 *Question ${progress}*\n\n${q.question}`;
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
  if (!session) return false; // no active session, handle as normal chat

  const questions = JSON.parse(session.questions_json);
  const currentIndex = session.current_question;
  const q = questions[currentIndex];

  // Evaluate the answer with Claude for flexibility
  const evalPrompt = `A Japanese student answered a question. Determine if their answer is correct or acceptable.

Question: ${q.question}
Expected answer: ${q.answer}
Student's answer: ${userAnswer}

Be lenient — accept answers that are correct in meaning even if formatting differs slightly.
Also accept reasonable romaji if the expected answer is in hiragana/katakana.

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
    evaluation = { correct: false, explanation: "Could not evaluate answer.", correct_form: q.answer };
  }

  const wasCorrect = evaluation.correct;

  // Log the answer
  logAnswer(session.id, chatId, q.question, q.answer, userAnswer, wasCorrect);

  // Update SRS schedule for this word
  if (q.vocab_id) {
    updateWordAfterReview(chatId, q.vocab_id, wasCorrect);
  }

  // Update session score
  updateSession(session.id, {
    correct: session.correct + (wasCorrect ? 1 : 0),
    incorrect: session.incorrect + (wasCorrect ? 0 : 1),
  });

  // Build feedback message
  let feedback;
  if (wasCorrect) {
    feedback = `✅ *正解！* Great job!\n${evaluation.explanation}`;
  } else {
    feedback = `❌ *Not quite!*\n${evaluation.explanation}\n✏️ Correct answer: *${q.answer}*`;
  }

  // Add vocab note
  if (q.vocab_word) {
    feedback += `\n\n📚 ${q.vocab_word} (${q.vocab_reading}) = ${q.vocab_meaning}`;
  }

  await sendFn(chatId, feedback);

  // Move to next question or end session
  const nextIndex = currentIndex + 1;
  if (nextIndex < questions.length) {
    setTimeout(() => sendQuestion(chatId, session.id, questions, nextIndex, sendFn), 1500);
  } else {
    setTimeout(() => finishSession(chatId, session, sendFn), 1500);
  }

  return true; // handled
}

// ── Finish session with summary ───────────────────────
async function finishSession(chatId, session, sendFn) {
  endSession(session.id);

  const total = session.total_questions;
  const correct = session.correct + 1; // account for last answer
  const incorrect = total - correct;
  const score = Math.round((correct / total) * 100);

  let emoji = score >= 80 ? "🌟" : score >= 60 ? "👍" : "💪";
  let verdict = score >= 80 ? "Excellent work!" : score >= 60 ? "Good effort!" : "Keep practicing — you're improving!";

  const summary = `${emoji} *Session Complete!*

📊 Score: ${correct}/${total} (${score}%)
✅ Correct: ${correct}
❌ Incorrect: ${incorrect}

${verdict}

${score < 80 ? "I'll make sure to review the tricky ones again next session. 復習しましょう！" : "素晴らしい！Keep up the great work! 🎉"}`;

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
