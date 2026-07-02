import "dotenv/config";
import { query } from "./db.js";

const SOURCES = [
  {
    level: "N4",
    url: "https://raw.githubusercontent.com/jamsinclair/open-anki-jlpt-decks/main/src/n4.csv",
  },
  {
    level: "N3",
    url: "https://raw.githubusercontent.com/jamsinclair/open-anki-jlpt-decks/main/src/n3.csv",
  },
];

function parseCSV(text) {
  const lines = text.trim().split("\n");
  const words = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = [];
    let current = "";
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        cols.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    cols.push(current.trim());
    if (cols.length >= 3) {
      const word = cols[0]?.trim();
      const reading = cols[1]?.trim();
      const meaning = cols[2]?.trim();
      if (word && reading && meaning) {
        words.push({ word, reading, meaning });
      }
    }
  }
  return words;
}

async function seedLevel(level, url) {
  console.log(`📥 Downloading ${level} vocab from GitHub...`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${level}: ${response.status}`);

  const text = await response.text();
  const words = parseCSV(text);
  console.log(`📝 Parsed ${words.length} words for ${level}`);

  const existing = await query(
    "SELECT COUNT(*) as count FROM vocab_master WHERE level = $1",
    [level]
  );
  if (parseInt(existing.rows[0].count) > 0) {
    console.log(`⚠️  ${level} already has ${existing.rows[0].count} words. Skipping.`);
    return parseInt(existing.rows[0].count);
  }

  // Batch insert
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    await query(
      `INSERT INTO vocab_master (word, reading, meaning, level, frequency_rank)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (word, level) DO NOTHING`,
      [w.word, w.reading, w.meaning, level, i + 1]
    );
  }

  console.log(`✅ Inserted ${words.length} ${level} words`);
  return words.length;
}

async function seed() {
  console.log("🌱 Starting vocabulary seed...");
  for (const source of SOURCES) {
    try {
      await seedLevel(source.level, source.url);
    } catch (err) {
      console.error(`❌ Failed to seed ${source.level}:`, err.message);
    }
  }

  const n4 = await query("SELECT COUNT(*) as c FROM vocab_master WHERE level = 'N4'");
  const n3 = await query("SELECT COUNT(*) as c FROM vocab_master WHERE level = 'N3'");
  console.log(`🎉 Seed complete! N4: ${n4.rows[0].c}, N3: ${n3.rows[0].c}`);
}

export default seed;
