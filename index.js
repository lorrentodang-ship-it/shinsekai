import "dotenv/config";
import { initDB, query } from "./db.js";
import seed from "./seed.js";
import seedGrammar from "./seed_grammar.js";

console.log("🚀 Initializing database...");
await initDB();

// Seed vocab if empty
const vocabRes = await query("SELECT COUNT(*) as c FROM vocab_master");
const vocabCount = parseInt(vocabRes.rows[0].c);
if (vocabCount === 0) {
  console.log("📚 Seeding vocab database...");
  await seed();
} else {
  console.log(`📚 Vocab ready: ${vocabCount} words`);
}

// Seed grammar if empty
const grammarRes = await query("SELECT COUNT(*) as c FROM grammar_master");
const grammarCount = parseInt(grammarRes.rows[0].c);
if (grammarCount === 0) {
  console.log("📝 Seeding grammar database...");
  await seedGrammar();
} else {
  console.log(`📝 Grammar ready: ${grammarCount} patterns`);
}

console.log("✅ Database ready. Bot is paused — website coming soon.");

// Keep process alive (Railway requires a running process)
setInterval(() => {}, 1000 * 60 * 60);
