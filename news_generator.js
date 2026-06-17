import Anthropic from "@anthropic-ai/sdk";
import { saveStoryToCache, getCachedStory, updateTTSFileId } from "./db.js";
import { TOPIC_FEEDS } from "./news.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Map japanese_level → news difficulty tier
export function levelToNewsTier(japaneseLevel) {
  const level = (japaneseLevel || "unknown").toLowerCase();
  if (["n1", "n2"].includes(level)) return "advanced";
  if (["n3"].includes(level)) return "intermediate";
  return "beginner"; // N4, N5, beginner, unknown
}

// ── Generate all 3 level versions for one story ───────
export async function generateGradedStory(article, cacheDate) {
  const topic = article.topic;
  const storyIndex = article.storyIndex || 0;

  // Check cache first
  const cached = getCachedStory(cacheDate, topic, storyIndex);
  if (cached) {
    console.log(`  ✅ Cache hit: ${topic} story ${storyIndex}`);
    return cached;
  }

  const prompt = `You are a Japanese language tutor. Generate graded Japanese summaries of this news story at 3 difficulty levels.

Story: ${article.title}
Details: ${article.summary || ""}
Source: ${article.source}

Return JSON only — no markdown:
{
  "headline_ja": "natural Japanese translation of the headline",
  "beginner": {
    "summary_ja": "1-2 short sentences, N5-N4 vocabulary, hiragana heavy, furigana on all kanji, very simple grammar",
    "vocab": [
      {"word": "経済", "reading": "けいざい", "meaning": "economy"}
    ],
    "audio_text": "clean spoken Japanese for TTS — same as summary but written naturally for speech, no punctuation symbols"
  },
  "intermediate": {
    "summary_ja": "2-3 sentences, N4-N3 vocabulary, natural Japanese with kanji, some complex grammar",
    "vocab": [
      {"word": "成長率", "reading": "せいちょうりつ", "meaning": "growth rate"}
    ],
    "audio_text": "clean spoken Japanese for TTS"
  },
  "advanced": {
    "summary_ja": "3-4 sentences, N2-N1 vocabulary, native-level Japanese, no simplification, sophisticated expressions",
    "vocab": [
      {"word": "急騰", "reading": "きゅうとう", "meaning": "sharp rise"}
    ],
    "audio_text": "clean spoken Japanese for TTS"
  }
}

Rules:
- vocab: 2-3 words per level, appropriate to that level
- audio_text: NO emoji, NO bullet points, NO vocab lists — just natural spoken sentences
- Keep each level genuinely different in complexity`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1200,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = response.content[0].text.replace(/```json|```/g, "").trim();
  const data = JSON.parse(raw);

  // Save to cache
  saveStoryToCache(cacheDate, topic, storyIndex, {
    headline_ja:          data.headline_ja,
    beginner_summary:     data.beginner.summary_ja,
    beginner_vocab:       data.beginner.vocab,
    beginner_audio:       data.beginner.audio_text,
    intermediate_summary: data.intermediate.summary_ja,
    intermediate_vocab:   data.intermediate.vocab,
    intermediate_audio:   data.intermediate.audio_text,
    advanced_summary:     data.advanced.summary_ja,
    advanced_vocab:       data.advanced.vocab,
    advanced_audio:       data.advanced.audio_text,
  });

  return getCachedStory(cacheDate, topic, storyIndex);
}

// ── Generate and cache TTS audio, store file_id ───────
export async function ensureTTSCached(bot, chatId, cachedStory, tier) {
  const fileIdCol = `tts_${tier}_file_id`;
  if (cachedStory[fileIdCol]) return cachedStory[fileIdCol]; // already cached

  const audioText = cachedStory[`${tier}_audio`];
  if (!audioText) return null;

  const { textToSpeech } = await import("./tts.js");
  const filePath = await textToSpeech(audioText, `news_${tier}_${cachedStory.id}`);

  // Send to a dummy chat to get file_id — use the current user's chat
  const sent = await bot.sendVoice(chatId, filePath, { disable_notification: true });
  const fileId = sent.voice.file_id;

  // Cache the file_id
  updateTTSFileId(cachedStory.cache_date, cachedStory.topic, cachedStory.story_index, tier, fileId);

  // Clean up temp file
  const fs = await import("fs");
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  return fileId;
}
