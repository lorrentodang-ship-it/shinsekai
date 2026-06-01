import "dotenv/config";
import { initDB, db } from "./db.js";

// Raw CSV URLs from jamsinclair/open-anki-jlpt-decks (MIT licensed)
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

    // CSV format: word,reading,"meaning",tags,id
    // Handle quoted fields with commas inside
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
  if (!response.ok) {
    throw new Error(`Failed to fetch ${level}: ${response.status}`);
  }

  const text = await response.text();
  const words = parseCSV(text);

  console.log(`📝 Parsed ${words.length} words for ${level}`);

  // Check how many already exist
  const existing = db.prepare(
    "SELECT COUNT(*) as count FROM vocab_master WHERE level = ?"
  ).get(level);

  if (existing.count > 0) {
    console.log(`⚠️  ${level} already has ${existing.count} words in database. Skipping.`);
    console.log(`   Run with --force to re-import.`);
    return existing.count;
  }

  // Insert all words
  const insert = db.prepare(
    `INSERT OR IGNORE INTO vocab_master (word, reading, meaning, level, frequency_rank)
     VALUES (?, ?, ?, ?, ?)`
  );

  const insertMany = db.transaction((words) => {
    words.forEach((w, i) => {
      insert.run(w.word, w.reading, w.meaning, level, i + 1);
    });
  });

  insertMany(words);
  console.log(`✅ Inserted ${words.length} ${level} words into vocab_master`);
  return words.length;
}

async function seed() {
  const force = process.argv.includes("--force");

  console.log("🌱 Starting vocabulary database seed...\n");
  initDB();

  if (force) {
    console.log("⚠️  Force mode: clearing existing vocab_master data...");
    db.prepare("DELETE FROM vocab_master").run();
  }

  let total = 0;
  for (const source of SOURCES) {
    try {
      const count = await seedLevel(source.level, source.url);
      total += count;
    } catch (err) {
      console.error(`❌ Failed to seed ${source.level}:`, err.message);
    }
  }

  // Summary
  const n4Count = db.prepare("SELECT COUNT(*) as c FROM vocab_master WHERE level = 'N4'").get().c;
  const n3Count = db.prepare("SELECT COUNT(*) as c FROM vocab_master WHERE level = 'N3'").get().c;

  console.log(`\n🎉 Seed complete!`);
  console.log(`   N4 words: ${n4Count}`);
  console.log(`   N3 words: ${n3Count}`);
  console.log(`   Total: ${n4Count + n3Count}`);
}

export default seed;
