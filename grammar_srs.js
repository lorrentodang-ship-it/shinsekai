import { db } from "./db.js";

const REVIEW_INTERVALS = {
  0: 1,
  1: 1,
  2: 3,
  3: 7,
  4: 14,
  5: 30,
};

const MAX_CONFIDENCE = 5;
const NEW_GRAMMAR_PER_DAY = 2;  // minimum 2 new patterns per session

// ── Get grammar patterns due for review ──────────────
export function getGrammarDueForReview(chatId, limit = 4) {
  const today = new Date().toISOString();
  return db.prepare(`
    SELECT ug.*, gm.pattern, gm.romaji, gm.meaning, gm.category,
           gm.difficulty_rank, gm.example_sentence, ug.question_level
    FROM user_grammar ug
    JOIN grammar_master gm ON ug.grammar_id = gm.id
    WHERE ug.chat_id = ?
      AND ug.status != 'mastered'
      AND ug.next_review <= ?
    ORDER BY ug.next_review ASC, ug.confidence ASC
    LIMIT ?
  `).all(chatId, today, limit);
}

// ── Get new grammar patterns never introduced ─────────
export function getNewGrammarPatterns(chatId, limit = NEW_GRAMMAR_PER_DAY) {
  // Ordered by difficulty_rank so easier patterns come first
  return db.prepare(`
    SELECT gm.*
    FROM grammar_master gm
    WHERE gm.id NOT IN (
      SELECT grammar_id FROM user_grammar WHERE chat_id = ?
    )
    ORDER BY gm.difficulty_rank ASC, gm.id ASC
    LIMIT ?
  `).all(chatId, limit);
}

// ── Get today's full grammar session (8 questions) ───
export function getTodaysGrammarSession(chatId) {
  // 4 review patterns (due or recently wrong)
  const reviewPatterns = getGrammarDueForReview(chatId, 4);

  // Ensure at least 2 new patterns, fill up to 4 new
  const newNeeded = Math.max(NEW_GRAMMAR_PER_DAY, 4 - reviewPatterns.length);
  const newPatterns = getNewGrammarPatterns(chatId, newNeeded);

  // Introduce new patterns to user's tracker
  for (const p of newPatterns) {
    introduceGrammarPattern(chatId, p.id);
  }

  return {
    reviewPatterns,
    newPatterns,
    allPatterns: [...newPatterns, ...reviewPatterns], // new first, then review
  };
}

// ── Introduce a new grammar pattern to a user ─────────
export function introduceGrammarPattern(chatId, grammarId) {
  const existing = db.prepare(
    "SELECT id FROM user_grammar WHERE chat_id = ? AND grammar_id = ?"
  ).get(chatId, grammarId);

  if (existing) return;

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  db.prepare(`
    INSERT INTO user_grammar
      (chat_id, grammar_id, status, confidence, question_level, next_review)
    VALUES (?, ?, 'learning', 0, 1, ?)
  `).run(chatId, grammarId, tomorrow.toISOString());
}

// ── Update grammar after a review ────────────────────
export function updateGrammarAfterReview(chatId, grammarId, wasCorrect) {
  const entry = db.prepare(
    "SELECT * FROM user_grammar WHERE chat_id = ? AND grammar_id = ?"
  ).get(chatId, grammarId);

  if (!entry) return;

  let newConfidence;
  if (wasCorrect) {
    newConfidence = Math.min(entry.confidence + 1, MAX_CONFIDENCE);
  } else {
    newConfidence = Math.max(entry.confidence - 1, 0);
  }

  const daysUntilReview = REVIEW_INTERVALS[newConfidence] || 1;
  const nextReview = new Date();
  nextReview.setDate(nextReview.getDate() + daysUntilReview);

  const status = newConfidence >= MAX_CONFIDENCE ? "mastered"
    : newConfidence >= 2 ? "reviewing"
    : "learning";

  // Escalate question level based on confidence
  // 0-1 → Level 1 (recognition), 2-3 → Level 2 (production), 4-5 → Level 3 (nuance)
  const questionLevel = newConfidence <= 1 ? 1 : newConfidence <= 3 ? 2 : 3;

  db.prepare(`
    UPDATE user_grammar SET
      confidence = ?,
      status = ?,
      question_level = ?,
      next_review = ?,
      times_seen = times_seen + 1,
      times_correct = times_correct + ?,
      times_wrong = times_wrong + ?,
      last_seen = CURRENT_TIMESTAMP
    WHERE chat_id = ? AND grammar_id = ?
  `).run(
    newConfidence,
    status,
    questionLevel,
    nextReview.toISOString(),
    wasCorrect ? 1 : 0,
    wasCorrect ? 0 : 1,
    chatId,
    grammarId
  );
}

// ── Get N3 grammar stats for a user ──────────────────
export function getGrammarStats(chatId) {
  return db.prepare(`
    SELECT
      COUNT(*) as total_seen,
      SUM(CASE WHEN status = 'mastered' THEN 1 ELSE 0 END) as mastered,
      SUM(CASE WHEN status = 'reviewing' THEN 1 ELSE 0 END) as reviewing,
      SUM(CASE WHEN status = 'learning' THEN 1 ELSE 0 END) as learning
    FROM user_grammar
    WHERE chat_id = ?
  `).get(chatId);
}

// ── Total grammar patterns available ─────────────────
export function getTotalGrammarCount() {
  return db.prepare("SELECT COUNT(*) as total FROM grammar_master").get();
}

// ── Build prompt section for Claude ──────────────────
export function buildGrammarPromptSection(session) {
  const { newPatterns, reviewPatterns } = session;

  const newSection = newPatterns.length > 0
    ? `NEW PATTERNS (introduce today — student has never seen these):\n` +
      newPatterns.map((p, i) =>
        `${i + 1}. ${p.pattern} (${p.romaji}) = ${p.meaning}\n   Example: ${p.example_sentence}\n   → Write a Level 1 RECOGNITION question (multiple choice)`
      ).join("\n")
    : "";

  const reviewSection = reviewPatterns.length > 0
    ? `REVIEW PATTERNS (student has seen these — test at appropriate level):\n` +
      reviewPatterns.map((p, i) => {
        const level = p.question_level || 1;
        const levelDesc = level === 1 ? "Level 1: RECOGNITION (multiple choice)"
          : level === 2 ? "Level 2: PRODUCTION (fill in blank / translate)"
          : "Level 3: NUANCE (write own sentence or explain difference from similar pattern)";
        return `${i + 1}. ${p.pattern} (${p.romaji}) = ${p.meaning} [confidence: ${p.confidence}/5]\n   → ${levelDesc}`;
      }).join("\n")
    : "";

  return `${newSection}\n\n${reviewSection}`.trim();
}
