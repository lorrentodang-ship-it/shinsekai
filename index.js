import { bot, startBot } from "./bot.js";
import { initDB } from "./db.js";

console.log("🤖 Starting Japanese Tutor Bot...");
await initDB();
await startBot();
console.log("✅ Bot is running!");
