import "dotenv/config";
import { startBot } from "./bot.js";
import { initDB } from "./db.js";
import { startScheduler } from "./scheduler.js";

console.log("🤖 Starting Japanese Tutor Bot...");
await initDB();
await startBot();
startScheduler();
console.log("✅ Bot is running!");
