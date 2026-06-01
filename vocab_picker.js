import { getTodaysSessionWords, introduceWord } from "./srs.js";
import { db } from "./db.js";

// ── Get words for a practice session ─────────────────
// Returns formatted word list ready to pass to Claude
export function getSessionVocab(chatId) {
  const { dueWords, newWords, allWords } = getTodaysSessionWords(chatId);

  // Introduce new words to the user's vocab tracker
  for (const word of newWords) {
    introduceWord(chatId, word.id);
  }

  // Format for Claude prompt
  const formatted = allWords.map(w => ({
    id: w.vocab_id || w.id,
    word: w.word,
    reading: w.reading,
    meaning: w.meaning,
    level: w.level,
    isNew: !w.vocab_id, // vocab_id means it came from user_vocab (existing)
    isDue: !!w.next_review, // has a review date = due for review
  }));

  return {
    words: formatted,
    dueCount: dueWords.length,
    newCount: newWords.length,
    summary: `${dueWords.length} review words + ${newWords.length} new words`,
  };
}

// ── Build Claude prompt section for vocab ─────────────
export function buildVocabPromptSection(sessionVocab) {
  const { words, summary } = sessionVocab;

  const wordList = words.map((w, i) =>
    `${i + 1}. ${w.word} (${w.reading}) = ${w.meaning} [${w.level}${w.isNew ? ", NEW" : ", REVIEW"}]`
  ).join("\n");

  return `Today's vocabulary words to use in this session (${summary}):
${wordList}

IMPORTANT: Build all questions around ONLY these specific words. Do not introduce other vocabulary.
For NEW words, be a bit more supportive in hints. For REVIEW words, be more challenging.`;
}

// ── Check if a word from news matches vocab list ──────
export function findVocabMatch(text) {
  // Get all vocab_master words and check if they appear in the text
  const allWords = db.prepare(
    "SELECT * FROM vocab_master ORDER BY LENGTH(word) DESC"
  ).all();

  const matches = [];
  for (const entry of allWords) {
    if (text.includes(entry.word)) {
      matches.push(entry);
    }
  }

  // Return top 3 matches to avoid overwhelming
  return matches.slice(0, 3);
}

// ── Get today's new words (for evening session use) ───
export function getTodaysNewWords(chatId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return db.prepare(`
    SELECT uv.*, vm.word, vm.reading, vm.meaning, vm.level
    FROM user_vocab uv
    JOIN vocab_master vm ON uv.vocab_id = vm.id
    WHERE uv.chat_id = ?
      AND uv.last_seen >= ?
      AND uv.times_seen = 1
    ORDER BY uv.last_seen ASC
    LIMIT 5
  `).all(chatId, today.toISOString());
}
