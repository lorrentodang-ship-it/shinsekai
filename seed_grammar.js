import { query } from "./db.js";
import { N3_GRAMMAR } from "./grammar_master_data.js";

async function seedGrammar() {
  const existing = await query("SELECT COUNT(*) as c FROM grammar_master");
  const count = parseInt(existing.rows[0].c);

  if (count > 0) {
    console.log(`⚠️  grammar_master already has ${count} patterns. Skipping.`);
    return count;
  }

  console.log(`📝 Seeding ${N3_GRAMMAR.length} N3 grammar patterns...`);

  for (const g of N3_GRAMMAR) {
    await query(
      `INSERT INTO grammar_master
       (pattern, romaji, meaning, category, difficulty_rank, example_sentence)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (pattern) DO NOTHING`,
      [g.pattern, g.romaji, g.meaning, g.category, g.difficulty_rank, g.example || ""]
    );
  }

  const final = await query("SELECT COUNT(*) as c FROM grammar_master");
  console.log(`✅ Inserted ${final.rows[0].c} grammar patterns`);

  const cats = await query(
    "SELECT category, COUNT(*) as c FROM grammar_master GROUP BY category ORDER BY c DESC"
  );
  cats.rows.forEach(r => console.log(`   ${r.category}: ${r.c}`));

  return parseInt(final.rows[0].c);
}

export default seedGrammar;
