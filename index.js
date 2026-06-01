import "dotenv/config";
import { startBot } from "./bot.js";
import { initDB, db } from "./db.js";
import { startScheduler } from "./scheduler.js";
import seed from "./seed.js";

console.log("🤖 Starting Japanese Tutor Bot...");
await initDB();

// Auto-seed vocab database if empty
const vocabCount = db.prepare("SELECT COUNT(*) as c FROM vocab_master").get().c;
if (vocabCount === 0) {
  console.log("📚 Vocab database empty — seeding now...");
  await seed();
} else {
  console.log(`📚 Vocab database ready: ${vocabCount} words loaded`);
}

await startBot();
startScheduler();
console.log("✅ Bot is running!");
