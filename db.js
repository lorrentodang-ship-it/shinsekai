import Database from "better-sqlite3";

export let db;

export function initDB() {
  db = new Database("tutor.db");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      chat_id TEXT PRIMARY KEY,
      name TEXT,
      japanese_level TEXT DEFAULT 'unknown',
      tutor_style TEXT DEFAULT 'encouraging',
      timezone TEXT DEFAULT 'Asia/Ho_Chi_Minh',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      role TEXT,
      content TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vocab_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      word TEXT,
      reading TEXT,
      meaning TEXT,
      times_seen INTEGER DEFAULT 1,
      confidence INTEGER DEFAULT 0,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tutor_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      session_type TEXT DEFAULT 'vocab_grammar',
      state TEXT DEFAULT 'active',
      current_question INTEGER DEFAULT 0,
      total_questions INTEGER DEFAULT 8,
      correct INTEGER DEFAULT 0,
      incorrect INTEGER DEFAULT 0,
      questions_json TEXT,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS session_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      chat_id TEXT,
      question TEXT,
      correct_answer TEXT,
      user_answer TEXT,
      was_correct INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS listening_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      session_data TEXT,
      current_part INTEGER DEFAULT 0,
      state TEXT DEFAULT 'active',
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS vocab_master (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word TEXT NOT NULL,
      reading TEXT NOT NULL,
      meaning TEXT NOT NULL,
      level TEXT NOT NULL,
      frequency_rank INTEGER DEFAULT 999,
      UNIQUE(word, level)
    );

    CREATE TABLE IF NOT EXISTS user_vocab (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      vocab_id INTEGER NOT NULL,
      status TEXT DEFAULT 'learning',
      confidence INTEGER DEFAULT 0,
      next_review DATETIME,
      times_seen INTEGER DEFAULT 0,
      times_correct INTEGER DEFAULT 0,
      times_wrong INTEGER DEFAULT 0,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chat_id, vocab_id),
      FOREIGN KEY(vocab_id) REFERENCES vocab_master(id)
    );

    CREATE TABLE IF NOT EXISTS grammar_master (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL,
      romaji TEXT NOT NULL,
      meaning TEXT NOT NULL,
      category TEXT NOT NULL,
      difficulty_rank INTEGER DEFAULT 1,
      example_sentence TEXT DEFAULT '',
      UNIQUE(pattern)
    );

    CREATE TABLE IF NOT EXISTS user_grammar (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      grammar_id INTEGER NOT NULL,
      status TEXT DEFAULT 'learning',
      confidence INTEGER DEFAULT 0,
      question_level INTEGER DEFAULT 1,
      next_review DATETIME,
      times_seen INTEGER DEFAULT 0,
      times_correct INTEGER DEFAULT 0,
      times_wrong INTEGER DEFAULT 0,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chat_id, grammar_id),
      FOREIGN KEY(grammar_id) REFERENCES grammar_master(id)
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      chat_id TEXT PRIMARY KEY,
      news_topics TEXT DEFAULT '[]',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS news_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cache_date TEXT NOT NULL,
      topic TEXT NOT NULL,
      story_index INTEGER NOT NULL,
      headline_ja TEXT,
      beginner_summary TEXT,
      beginner_vocab TEXT,
      beginner_audio TEXT,
      intermediate_summary TEXT,
      intermediate_vocab TEXT,
      intermediate_audio TEXT,
      advanced_summary TEXT,
      advanced_vocab TEXT,
      advanced_audio TEXT,
      tts_beginner_file_id TEXT,
      tts_intermediate_file_id TEXT,
      tts_advanced_file_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(cache_date, topic, story_index)
    );
  `);

  console.log("✅ Database initialized");
}

// ── User ──────────────────────────────────────────────
export function getUser(chatId) {
  return db.prepare("SELECT * FROM users WHERE chat_id = ?").get(chatId);
}

export function upsertUser(chatId, data = {}) {
  const existing = getUser(chatId);
  if (!existing) {
    db.prepare("INSERT INTO users (chat_id, name) VALUES (?, ?)").run(chatId, data.name || "friend");
  } else if (Object.keys(data).length > 0) {
    const fields = Object.keys(data).map(k => `${k} = ?`).join(", ");
    db.prepare(`UPDATE users SET ${fields} WHERE chat_id = ?`).run(...Object.values(data), chatId);
  }
  return getUser(chatId);
}

// ── Message history ───────────────────────────────────
export function getHistory(chatId, limit = 20) {
  return db.prepare(
    "SELECT role, content FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?"
  ).all(chatId, limit).reverse();
}

export function saveMessage(chatId, role, content) {
  db.prepare("INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)").run(chatId, role, content);
}

export function clearHistory(chatId) {
  db.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId);
}

// ── Vocab log ─────────────────────────────────────────
export function logVocab(chatId, word, reading, meaning) {
  const existing = db.prepare("SELECT * FROM vocab_log WHERE chat_id = ? AND word = ?").get(chatId, word);
  if (existing) {
    db.prepare("UPDATE vocab_log SET times_seen = times_seen + 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?").run(existing.id);
  } else {
    db.prepare("INSERT INTO vocab_log (chat_id, word, reading, meaning) VALUES (?, ?, ?, ?)").run(chatId, word, reading, meaning);
  }
}

export function updateVocabConfidence(chatId, word, correct) {
  const existing = db.prepare("SELECT * FROM vocab_log WHERE chat_id = ? AND word = ?").get(chatId, word);
  if (existing) {
    const newConfidence = Math.max(0, existing.confidence + (correct ? 1 : -1));
    db.prepare("UPDATE vocab_log SET confidence = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?").run(newConfidence, existing.id);
  }
}

export function getVocabLog(chatId, limit = 10) {
  return db.prepare("SELECT * FROM vocab_log WHERE chat_id = ? ORDER BY last_seen DESC LIMIT ?").all(chatId, limit);
}

export function getWeakVocab(chatId, limit = 5) {
  return db.prepare(
    "SELECT * FROM vocab_log WHERE chat_id = ? ORDER BY confidence ASC, last_seen ASC LIMIT ?"
  ).all(chatId, limit);
}

// ── Tutor sessions ────────────────────────────────────
export function createSession(chatId, questionsJson, totalQuestions = 8, sessionType = "vocab") {
  const result = db.prepare(
    `INSERT INTO tutor_sessions (chat_id, questions_json, total_questions, session_type) VALUES (?, ?, ?, ?)`
  ).run(chatId, JSON.stringify(questionsJson), totalQuestions, sessionType);
  return result.lastInsertRowid;
}

export function getActiveSession(chatId) {
  return db.prepare(
    "SELECT * FROM tutor_sessions WHERE chat_id = ? AND state = 'active' ORDER BY started_at DESC LIMIT 1"
  ).get(chatId);
}

export function updateSession(sessionId, data) {
  const fields = Object.keys(data).map(k => `${k} = ?`).join(", ");
  db.prepare(`UPDATE tutor_sessions SET ${fields} WHERE id = ?`).run(...Object.values(data), sessionId);
}

export function endSession(sessionId) {
  db.prepare("UPDATE tutor_sessions SET state = 'complete', ended_at = CURRENT_TIMESTAMP WHERE id = ?").run(sessionId);
}

export function logAnswer(sessionId, chatId, question, correctAnswer, userAnswer, wasCorrect) {
  db.prepare(
    `INSERT INTO session_answers (session_id, chat_id, question, correct_answer, user_answer, was_correct)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sessionId, chatId, question, correctAnswer, userAnswer, wasCorrect ? 1 : 0);
}

export function getSessionStats(chatId, limit = 7) {
  return db.prepare(
    `SELECT correct, incorrect, total_questions, started_at 
     FROM tutor_sessions WHERE chat_id = ? AND state = 'complete' 
     ORDER BY started_at DESC LIMIT ?`
  ).all(chatId, limit);
}

// ── User preferences (news topics) ───────────────────
export function getUserPreferences(chatId) {
  const row = db.prepare("SELECT * FROM user_preferences WHERE chat_id = ?").get(chatId);
  if (!row) return { chat_id: chatId, news_topics: [] };
  return { ...row, news_topics: JSON.parse(row.news_topics || "[]") };
}

export function setUserNewsTopics(chatId, topics) {
  const existing = db.prepare("SELECT chat_id FROM user_preferences WHERE chat_id = ?").get(chatId);
  if (existing) {
    db.prepare("UPDATE user_preferences SET news_topics = ?, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?")
      .run(JSON.stringify(topics), chatId);
  } else {
    db.prepare("INSERT INTO user_preferences (chat_id, news_topics) VALUES (?, ?)")
      .run(chatId, JSON.stringify(topics));
  }
}

export function getActiveNewsTopics() {
  const rows = db.prepare("SELECT news_topics FROM user_preferences WHERE news_topics != '[]'").all();
  const allTopics = new Set();
  for (const row of rows) {
    const topics = JSON.parse(row.news_topics || "[]");
    topics.forEach(t => allTopics.add(t));
  }
  return [...allTopics];
}

// ── News cache ────────────────────────────────────────
export function getCachedStory(cacheDate, topic, storyIndex) {
  return db.prepare(
    "SELECT * FROM news_cache WHERE cache_date = ? AND topic = ? AND story_index = ?"
  ).get(cacheDate, topic, storyIndex);
}

export function saveStoryToCache(cacheDate, topic, storyIndex, data) {
  db.prepare(`
    INSERT OR REPLACE INTO news_cache
    (cache_date, topic, story_index, headline_ja,
     beginner_summary, beginner_vocab, beginner_audio,
     intermediate_summary, intermediate_vocab, intermediate_audio,
     advanced_summary, advanced_vocab, advanced_audio)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cacheDate, topic, storyIndex, data.headline_ja,
    data.beginner_summary, JSON.stringify(data.beginner_vocab), data.beginner_audio,
    data.intermediate_summary, JSON.stringify(data.intermediate_vocab), data.intermediate_audio,
    data.advanced_summary, JSON.stringify(data.advanced_vocab), data.advanced_audio
  );
}

export function updateTTSFileId(cacheDate, topic, storyIndex, level, fileId) {
  const col = `tts_${level}_file_id`;
  db.prepare(`UPDATE news_cache SET ${col} = ? WHERE cache_date = ? AND topic = ? AND story_index = ?`)
    .run(fileId, cacheDate, topic, storyIndex);
}

export function getCachedStoriesForUser(cacheDate, topicKeys) {
  if (!topicKeys.length) return [];
  const placeholders = topicKeys.map(() => "?").join(",");
  return db.prepare(
    `SELECT * FROM news_cache WHERE cache_date = ? AND topic IN (${placeholders}) ORDER BY topic, story_index`
  ).all(cacheDate, ...topicKeys);
}
