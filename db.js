import pg from "pg";
const { Pool } = pg;

// ── Connection pool ───────────────────────────────────
export let pool;

export async function initDB() {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  // Test connection
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    console.log("✅ PostgreSQL connected");
  } finally {
    client.release();
  }

  await createTables();
  console.log("✅ Database initialized");
}

// ── Helper: run a query ───────────────────────────────
export async function query(text, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res;
  } finally {
    client.release();
  }
}

// ── Create all tables ─────────────────────────────────
async function createTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      chat_id TEXT PRIMARY KEY,
      name TEXT,
      japanese_level TEXT DEFAULT 'unknown',
      tutor_style TEXT DEFAULT 'encouraging',
      timezone TEXT DEFAULT 'Asia/Ho_Chi_Minh',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      chat_id TEXT,
      role TEXT,
      content TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS vocab_log (
      id SERIAL PRIMARY KEY,
      chat_id TEXT,
      word TEXT,
      reading TEXT,
      meaning TEXT,
      times_seen INTEGER DEFAULT 1,
      confidence INTEGER DEFAULT 0,
      last_seen TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tutor_sessions (
      id SERIAL PRIMARY KEY,
      chat_id TEXT,
      session_type TEXT DEFAULT 'vocab_grammar',
      state TEXT DEFAULT 'active',
      current_question INTEGER DEFAULT 0,
      total_questions INTEGER DEFAULT 8,
      correct INTEGER DEFAULT 0,
      incorrect INTEGER DEFAULT 0,
      questions_json TEXT,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      ended_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS session_answers (
      id SERIAL PRIMARY KEY,
      session_id INTEGER,
      chat_id TEXT,
      question TEXT,
      correct_answer TEXT,
      user_answer TEXT,
      was_correct INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS listening_sessions (
      id SERIAL PRIMARY KEY,
      chat_id TEXT,
      session_data TEXT,
      current_part INTEGER DEFAULT 0,
      state TEXT DEFAULT 'active',
      started_at TIMESTAMPTZ DEFAULT NOW(),
      ended_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS vocab_master (
      id SERIAL PRIMARY KEY,
      word TEXT NOT NULL,
      reading TEXT NOT NULL,
      meaning TEXT NOT NULL,
      level TEXT NOT NULL,
      frequency_rank INTEGER DEFAULT 999,
      UNIQUE(word, level)
    );

    CREATE TABLE IF NOT EXISTS user_vocab (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      vocab_id INTEGER NOT NULL,
      status TEXT DEFAULT 'learning',
      confidence INTEGER DEFAULT 0,
      next_review TIMESTAMPTZ,
      times_seen INTEGER DEFAULT 0,
      times_correct INTEGER DEFAULT 0,
      times_wrong INTEGER DEFAULT 0,
      last_seen TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(chat_id, vocab_id),
      FOREIGN KEY(vocab_id) REFERENCES vocab_master(id)
    );

    CREATE TABLE IF NOT EXISTS grammar_master (
      id SERIAL PRIMARY KEY,
      pattern TEXT NOT NULL UNIQUE,
      romaji TEXT NOT NULL,
      meaning TEXT NOT NULL,
      category TEXT NOT NULL,
      difficulty_rank INTEGER DEFAULT 1,
      example_sentence TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS user_grammar (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      grammar_id INTEGER NOT NULL,
      status TEXT DEFAULT 'learning',
      confidence INTEGER DEFAULT 0,
      question_level INTEGER DEFAULT 1,
      next_review TIMESTAMPTZ,
      times_seen INTEGER DEFAULT 0,
      times_correct INTEGER DEFAULT 0,
      times_wrong INTEGER DEFAULT 0,
      last_seen TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(chat_id, grammar_id),
      FOREIGN KEY(grammar_id) REFERENCES grammar_master(id)
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      chat_id TEXT PRIMARY KEY,
      news_topics TEXT DEFAULT '[]',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS news_cache (
      id SERIAL PRIMARY KEY,
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
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(cache_date, topic, story_index)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_id
      ON messages(chat_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_vocab_review
      ON user_vocab(chat_id, next_review);
    CREATE INDEX IF NOT EXISTS idx_user_grammar_review
      ON user_grammar(chat_id, next_review);
    CREATE INDEX IF NOT EXISTS idx_tutor_sessions_chat
      ON tutor_sessions(chat_id, started_at DESC);
  `);
}

// ── User ──────────────────────────────────────────────
export async function getUser(chatId) {
  const res = await query("SELECT * FROM users WHERE chat_id = $1", [chatId]);
  return res.rows[0] || null;
}

export async function upsertUser(chatId, data = {}) {
  const existing = await getUser(chatId);
  if (!existing) {
    await query(
      "INSERT INTO users (chat_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [chatId, data.name || "friend"]
    );
  } else if (Object.keys(data).length > 0) {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
    await query(
      `UPDATE users SET ${setClause} WHERE chat_id = $${keys.length + 1}`,
      [...values, chatId]
    );
  }
  return getUser(chatId);
}

// ── Message history ───────────────────────────────────
export async function getHistory(chatId, limit = 20) {
  const res = await query(
    `SELECT role, content FROM messages
     WHERE chat_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [chatId, limit]
  );
  return res.rows.reverse();
}

export async function saveMessage(chatId, role, content) {
  await query(
    "INSERT INTO messages (chat_id, role, content) VALUES ($1, $2, $3)",
    [chatId, role, content]
  );
}

export async function clearHistory(chatId) {
  await query("DELETE FROM messages WHERE chat_id = $1", [chatId]);
}

// ── Vocab log ─────────────────────────────────────────
export async function logVocab(chatId, word, reading, meaning) {
  const res = await query(
    "SELECT * FROM vocab_log WHERE chat_id = $1 AND word = $2",
    [chatId, word]
  );
  if (res.rows[0]) {
    await query(
      "UPDATE vocab_log SET times_seen = times_seen + 1, last_seen = NOW() WHERE id = $1",
      [res.rows[0].id]
    );
  } else {
    await query(
      "INSERT INTO vocab_log (chat_id, word, reading, meaning) VALUES ($1, $2, $3, $4)",
      [chatId, word, reading, meaning]
    );
  }
}

export async function updateVocabConfidence(chatId, word, correct) {
  const res = await query(
    "SELECT * FROM vocab_log WHERE chat_id = $1 AND word = $2",
    [chatId, word]
  );
  if (res.rows[0]) {
    const newConf = Math.max(0, res.rows[0].confidence + (correct ? 1 : -1));
    await query(
      "UPDATE vocab_log SET confidence = $1, last_seen = NOW() WHERE id = $2",
      [newConf, res.rows[0].id]
    );
  }
}

export async function getVocabLog(chatId, limit = 10) {
  const res = await query(
    "SELECT * FROM vocab_log WHERE chat_id = $1 ORDER BY last_seen DESC LIMIT $2",
    [chatId, limit]
  );
  return res.rows;
}

export async function getWeakVocab(chatId, limit = 5) {
  const res = await query(
    "SELECT * FROM vocab_log WHERE chat_id = $1 ORDER BY confidence ASC, last_seen ASC LIMIT $2",
    [chatId, limit]
  );
  return res.rows;
}

// ── Tutor sessions ────────────────────────────────────
export async function createSession(chatId, questionsJson, totalQuestions = 8, sessionType = "vocab") {
  const res = await query(
    `INSERT INTO tutor_sessions
     (chat_id, questions_json, total_questions, session_type)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [chatId, JSON.stringify(questionsJson), totalQuestions, sessionType]
  );
  return res.rows[0].id;
}

export async function getActiveSession(chatId) {
  const res = await query(
    `SELECT * FROM tutor_sessions
     WHERE chat_id = $1 AND state = 'active'
     ORDER BY started_at DESC LIMIT 1`,
    [chatId]
  );
  return res.rows[0] || null;
}

export async function updateSession(sessionId, data) {
  const keys = Object.keys(data);
  const values = Object.values(data);
  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  await query(
    `UPDATE tutor_sessions SET ${setClause} WHERE id = $${keys.length + 1}`,
    [...values, sessionId]
  );
}

export async function endSession(sessionId) {
  await query(
    "UPDATE tutor_sessions SET state = 'complete', ended_at = NOW() WHERE id = $1",
    [sessionId]
  );
}

export async function logAnswer(sessionId, chatId, question, correctAnswer, userAnswer, wasCorrect) {
  await query(
    `INSERT INTO session_answers
     (session_id, chat_id, question, correct_answer, user_answer, was_correct)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [sessionId, chatId, question, correctAnswer, userAnswer, wasCorrect ? 1 : 0]
  );
}

export async function getSessionStats(chatId, limit = 7) {
  const res = await query(
    `SELECT correct, incorrect, total_questions, started_at
     FROM tutor_sessions
     WHERE chat_id = $1 AND state = 'complete'
     ORDER BY started_at DESC LIMIT $2`,
    [chatId, limit]
  );
  return res.rows;
}

// ── User preferences ──────────────────────────────────
export async function getUserPreferences(chatId) {
  const res = await query(
    "SELECT * FROM user_preferences WHERE chat_id = $1",
    [chatId]
  );
  if (!res.rows[0]) return { chat_id: chatId, news_topics: [] };
  return { ...res.rows[0], news_topics: JSON.parse(res.rows[0].news_topics || "[]") };
}

export async function setUserNewsTopics(chatId, topics) {
  await query(
    `INSERT INTO user_preferences (chat_id, news_topics)
     VALUES ($1, $2)
     ON CONFLICT (chat_id) DO UPDATE
     SET news_topics = $2, updated_at = NOW()`,
    [chatId, JSON.stringify(topics)]
  );
}

export async function getActiveNewsTopics() {
  const res = await query(
    "SELECT news_topics FROM user_preferences WHERE news_topics != '[]'"
  );
  const allTopics = new Set();
  for (const row of res.rows) {
    const topics = JSON.parse(row.news_topics || "[]");
    topics.forEach(t => allTopics.add(t));
  }
  return [...allTopics];
}

// ── News cache ────────────────────────────────────────
export async function getCachedStory(cacheDate, topic, storyIndex) {
  const res = await query(
    "SELECT * FROM news_cache WHERE cache_date = $1 AND topic = $2 AND story_index = $3",
    [cacheDate, topic, storyIndex]
  );
  return res.rows[0] || null;
}

export async function saveStoryToCache(cacheDate, topic, storyIndex, data) {
  await query(
    `INSERT INTO news_cache
     (cache_date, topic, story_index, headline_ja,
      beginner_summary, beginner_vocab, beginner_audio,
      intermediate_summary, intermediate_vocab, intermediate_audio,
      advanced_summary, advanced_vocab, advanced_audio)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (cache_date, topic, story_index) DO UPDATE SET
       headline_ja = $4,
       beginner_summary = $5, beginner_vocab = $6, beginner_audio = $7,
       intermediate_summary = $8, intermediate_vocab = $9, intermediate_audio = $10,
       advanced_summary = $11, advanced_vocab = $12, advanced_audio = $13`,
    [
      cacheDate, topic, storyIndex, data.headline_ja,
      data.beginner_summary, JSON.stringify(data.beginner_vocab), data.beginner_audio,
      data.intermediate_summary, JSON.stringify(data.intermediate_vocab), data.intermediate_audio,
      data.advanced_summary, JSON.stringify(data.advanced_vocab), data.advanced_audio,
    ]
  );
}

export async function updateTTSFileId(cacheDate, topic, storyIndex, level, fileId) {
  const col = `tts_${level}_file_id`;
  await query(
    `UPDATE news_cache SET ${col} = $1
     WHERE cache_date = $2 AND topic = $3 AND story_index = $4`,
    [fileId, cacheDate, topic, storyIndex]
  );
}

export async function getCachedStoriesForUser(cacheDate, topicKeys) {
  if (!topicKeys.length) return [];
  const placeholders = topicKeys.map((_, i) => `$${i + 2}`).join(",");
  const res = await query(
    `SELECT * FROM news_cache
     WHERE cache_date = $1 AND topic IN (${placeholders})
     ORDER BY topic, story_index`,
    [cacheDate, ...topicKeys]
  );
  return res.rows;
}

// ── Direct query access (for files that need raw SQL) ──
// Backward-compat shim so files using db.prepare() have a path to migrate
export const db = {
  query,
  prepare: () => { throw new Error("db.prepare() is SQLite only — use db.query() instead"); }
};
