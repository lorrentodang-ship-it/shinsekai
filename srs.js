import { db } from "./db.js";

// Days between reviews based on confidence level (simplified SM-2)
const REVIEW_INTERVALS = {
  0: 1,   // new/wrong → review tomorrow
  1: 1,   // seen once → review tomorrow
  2: 3,   // getting it → review in 3 days
  3: 7,   // knows it → review in 1 week
  4: 14,  // solid → review in 2 weeks
  5: 30,  // mastered → review in 1 month
};

const MAX_CONFIDENCE = 5;
const NEW_WORDS_PER_DAY = 5; // 5 new words daily as agreed

// ── Get words due for review today ───────────────────
export function getWordsDueForReview(chatId, limit = 5) {
  const today = new Date().toISOString();
  return db.prepare(`
    SELECT uv.*, vm.word, vm.reading, vm.meaning, vm.level, vm.frequency_rank
    FROM user_vocab uv
    JOIN vocab_master vm ON uv.vocab_id = vm.id
    WHERE uv.chat_id = ?
      AND uv.status != 'mastered'
      AND uv.next_review <= ?
    ORDER BY uv.next_review ASC, uv.confidence ASC
    LIMIT ?
  `).all(chatId, today, limit);
}

// ── Get new words not yet introduced ─────────────────
export function getNewWords(chatId, limit = NEW_WORDS_PER_DAY) {
  // First pull from N4 (review level), then N3 (target level)
  // Words not yet in user_vocab for this user
  return db.prepare(`
    SELECT vm.*
    FROM vocab_master vm
    WHERE vm.id NOT IN (
      SELECT vocab_id FROM user_vocab WHERE chat_id = ?
    )
    ORDER BY 
      CASE vm.level WHEN 'N4' THEN 1 WHEN 'N3' THEN 2 ELSE 3 END,
      vm.frequency_rank ASC
    LIMIT ?
  `).all(chatId, limit);
}

// ── Get today's full word list for session ────────────
export function getTodaysSessionWords(chatId) {
  const dueWords = getWordsDueForReview(chatId, 5);
  const newWords = getNewWords(chatId, NEW_WORDS_PER_DAY - Math.min(dueWords.length, 3));

  // Ensure we have 8 total — fill with more due words if needed
  const allWords = [...dueWords.slice(0, 5), ...newWords];

  return {
    dueWords: dueWords.slice(0, 5),
    newWords,
    allWords: allWords.slice(0, 8),
  };
}

// ── Update word after a review ────────────────────────
export function updateWordAfterReview(chatId, vocabId, wasCorrect) {
  const entry = db.prepare(
    "SELECT * FROM user_vocab WHERE chat_id = ? AND vocab_id = ?"
  ).get(chatId, vocabId);

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

  db.prepare(`
    UPDATE user_vocab SET
      confidence = ?,
      status = ?,
      next_review = ?,
      times_seen = times_seen + 1,
      times_correct = times_correct + ?,
      times_wrong = times_wrong + ?,
      last_seen = CURRENT_TIMESTAMP
    WHERE chat_id = ? AND vocab_id = ?
  `).run(
    newConfidence,
    status,
    nextReview.toISOString(),
    wasCorrect ? 1 : 0,
    wasCorrect ? 0 : 1,
    chatId,
    vocabId
  );
}

// ── Introduce a new word to a user ───────────────────
export function introduceWord(chatId, vocabId) {
  const existing = db.prepare(
    "SELECT id FROM user_vocab WHERE chat_id = ? AND vocab_id = ?"
  ).get(chatId, vocabId);

  if (existing) return; // already introduced

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  db.prepare(`
    INSERT INTO user_vocab (chat_id, vocab_id, status, confidence, next_review)
    VALUES (?, ?, 'learning', 0, ?)
  `).run(chatId, vocabId, tomorrow.toISOString());
}

// ── Flag a word as encountered (from news digest) ─────
export function markWordEncountered(chatId, word) {
  const vocabEntry = db.prepare(
    "SELECT * FROM vocab_master WHERE word = ?"
  ).get(word);

  if (!vocabEntry) return false; // word not in our list

  const existing = db.prepare(
    "SELECT * FROM user_vocab WHERE chat_id = ? AND vocab_id = ?"
  ).get(chatId, vocabEntry.id);

  if (!existing) {
    // Introduce it with a same-day review (tonight's session)
    const tonight = new Date();
    tonight.setHours(21, 0, 0, 0); // 9pm

    db.prepare(`
      INSERT INTO user_vocab (chat_id, vocab_id, status, confidence, next_review)
      VALUES (?, ?, 'learning', 0, ?)
    `).run(chatId, vocabEntry.id, tonight.toISOString());
  }

  return true;
}

// ── Get user progress stats ───────────────────────────
export function getUserVocabStats(chatId) {
  return db.prepare(`
    SELECT
      COUNT(*) as total_seen,
      SUM(CASE WHEN status = 'mastered' THEN 1 ELSE 0 END) as mastered,
      SUM(CASE WHEN status = 'reviewing' THEN 1 ELSE 0 END) as reviewing,
      SUM(CASE WHEN status = 'learning' THEN 1 ELSE 0 END) as learning,
      SUM(CASE WHEN uv.vocab_id IN (SELECT id FROM vocab_master WHERE level = 'N4') THEN 1 ELSE 0 END) as n4_seen,
      SUM(CASE WHEN uv.vocab_id IN (SELECT id FROM vocab_master WHERE level = 'N3') THEN 1 ELSE 0 END) as n3_seen
    FROM user_vocab uv
    WHERE chat_id = ?
  `).get(chatId);
}

// ── Total words available ─────────────────────────────
export function getTotalVocabCount() {
  return db.prepare(`
    SELECT
      SUM(CASE WHEN level = 'N4' THEN 1 ELSE 0 END) as n4_total,
      SUM(CASE WHEN level = 'N3' THEN 1 ELSE 0 END) as n3_total,
      COUNT(*) as total
    FROM vocab_master
  `).get();
}
