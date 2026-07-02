import "dotenv/config";
import { startBot } from "./bot.js";
import { initDB, query } from "./db.js";
import { startScheduler } from "./scheduler.js";
import seed from "./seed.js";
import seedGrammar from "./seed_grammar.js";

console.log("🤖 Starting Japanese Tutor Bot...");
await initDB();

// Auto-seed vocab database if empty
const vocabRes = await query("SELECT COUNT(*) as c FROM vocab_master");
const vocabCount = parseInt(vocabRes.rows[0].c);
if (vocabCount === 0) {
  console.log("📚 Vocab database empty — seeding now...");
  await seed();
} else {
  console.log(`📚 Vocab database ready: ${vocabCount} words loaded`);
}

// Auto-seed grammar database if empty
const grammarRes = await query("SELECT COUNT(*) as c FROM grammar_master");
const grammarCount = parseInt(grammarRes.rows[0].c);
if (grammarCount === 0) {
  console.log("📝 Grammar database empty — seeding now...");
  await seedGrammar();
} else {
  console.log(`📝 Grammar database ready: ${grammarCount} patterns loaded`);
}

await startBot();
startScheduler();
console.log("✅ Bot is running!");
