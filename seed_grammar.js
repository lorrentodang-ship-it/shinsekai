import { initDB, db } from "./db.js";
import { N3_GRAMMAR } from "./grammar_master_data.js";

async function seedGrammar() {
  const existing = db.prepare("SELECT COUNT(*) as c FROM grammar_master").get().c;

  if (existing > 0) {
    console.log(`⚠️  grammar_master already has ${existing} patterns. Skipping.`);
    console.log(`   Run with --force to re-import.`);
    return existing;
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO grammar_master
      (pattern, romaji, meaning, category, difficulty_rank, example_sentence)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((patterns) => {
    patterns.forEach(g => {
      insert.run(g.pattern, g.romaji, g.meaning, g.category, g.difficulty_rank, g.example || "");
    });
  });

  insertMany(N3_GRAMMAR);

  const count = db.prepare("SELECT COUNT(*) as c FROM grammar_master").get().c;
  console.log(`✅ Inserted ${count} N3 grammar patterns into grammar_master`);

  // Log category breakdown
  const cats = db.prepare(
    "SELECT category, COUNT(*) as c FROM grammar_master GROUP BY category ORDER BY c DESC"
  ).all();
  cats.forEach(r => console.log(`   ${r.category}: ${r.c}`));

  return count;
}

export default seedGrammar;
