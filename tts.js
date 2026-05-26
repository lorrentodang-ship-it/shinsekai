import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = path.join(__dirname, "tmp");

// Ensure tmp directory exists
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

// Convert text to speech and return file path
export async function textToSpeech(text, filename = "audio") {
  const filePath = path.join(TMP_DIR, `${filename}_${Date.now()}.ogg`);

  const response = await openai.audio.speech.create({
    model: "tts-1",
    voice: "nova",        // nova sounds natural and clear for Japanese
    input: text,
    response_format: "opus", // opus = .ogg directly, no conversion needed
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

// Send a voice message to a Telegram chat
export async function sendVoiceMessage(bot, chatId, text, filename = "audio") {
  let filePath;
  try {
    filePath = await textToSpeech(text, filename);
    await bot.sendVoice(chatId, filePath);
  } finally {
    // Clean up temp file after sending
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}
