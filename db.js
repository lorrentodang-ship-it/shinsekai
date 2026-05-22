import Database from "better-sqlite3";

let db;

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
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("✅ Database initialized");
}

// User operations
export function getUser(chatId) {
  return db.prepare("SELECT * FROM users WHERE chat_id = ?").get(chatId);
}

export function upsertUser(chatId, data = {}) {
  const existing = getUser(chatId);
  if (!existing) {
    db.prepare(
      "INSERT INTO users (chat_id, name) VALUES (?, ?)"
    ).run(chatId, data.name || "friend");
  } else if (Object.keys(data).length > 0) {
    const fields = Object.keys(data).map(k => `${k} = ?`).join(", ");
    db.prepare(`UPDATE users SET ${fields} WHERE chat_id = ?`)
      .run(...Object.values(data), chatId);
  }
  return getUser(chatId);
}

// Message history (last 20 messages for context)
export function getHistory(chatId, limit = 20) {
  return db.prepare(
    "SELECT role, content FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?"
  ).all(chatId, limit).reverse();
}

export function saveMessage(chatId, role, content) {
  db.prepare(
    "INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)"
  ).run(chatId, role, content);
}

export function clearHistory(chatId) {
  db.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId);
}

// Vocab log
export function logVocab(chatId, word, reading, meaning) {
  const existing = db.prepare(
    "SELECT * FROM vocab_log WHERE chat_id = ? AND word = ?"
  ).get(chatId, word);

  if (existing) {
    db.prepare(
      "UPDATE vocab_log SET times_seen = times_seen + 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(existing.id);
  } else {
    db.prepare(
      "INSERT INTO vocab_log (chat_id, word, reading, meaning) VALUES (?, ?, ?, ?)"
    ).run(chatId, word, reading, meaning);
  }
}

export function getVocabLog(chatId, limit = 10) {
  return db.prepare(
    "SELECT * FROM vocab_log WHERE chat_id = ? ORDER BY last_seen DESC LIMIT ?"
  ).all(chatId, limit);
}
