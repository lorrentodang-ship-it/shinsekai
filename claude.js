import Anthropic from "@anthropic-ai/sdk";
import { getHistory, saveMessage, getUser } from "./db.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildSystemPrompt(user) {
  const level = user?.japanese_level || "unknown";
  const style = user?.tutor_style || "encouraging";
  const name = user?.name || "friend";

  const levelGuide = {
    beginner: "Use very simple Japanese with hiragana/katakana. Always provide romaji and English translations. Focus on JLPT N5 vocabulary and grammar.",
    N5: "Use simple Japanese with hiragana/katakana. Provide English translations. Focus on JLPT N5 content.",
    N4: "Use Japanese with kanji (provide furigana). Translations when needed. Focus on JLPT N4 content.",
    N3: "Use natural Japanese. Provide hints rather than full translations. Focus on JLPT N3 content.",
    N2: "Use natural Japanese. Minimal translation support. Focus on JLPT N2 content.",
    N1: "Use advanced Japanese. Challenge the student. Focus on JLPT N1 and beyond.",
    unknown: "Start with simple Japanese and ask the student about their level early in the conversation.",
  };

  const styleGuide = {
    strict: "Be direct and correct mistakes firmly. Prioritize accuracy.",
    encouraging: "Be warm and supportive. Celebrate progress. Correct mistakes gently.",
    casual: "Be friendly and conversational, like a language exchange friend.",
  };

  return `You are Hana (はな), a friendly and knowledgeable Japanese language tutor on Telegram.

Your student's name is ${name}.
Their Japanese level: ${level}
Teaching style: ${styleGuide[style] || styleGuide.encouraging}
Level guidance: ${levelGuide[level] || levelGuide.unknown}

Core behaviors:
- When the student hasn't set their level yet, naturally ask about it early on and remember it
- Correct Japanese mistakes inline using the format: ✏️ [correction] — [brief explanation]
- When you introduce new vocabulary, format it as: 📚 word (reading) = meaning
- Mix Japanese and English naturally based on their level
- Be proactive — suggest practice activities, not just answer questions
- Remember context from the conversation history
- If they seem frustrated, be extra encouraging
- Keep responses concise for chat format (avoid huge walls of text)
- Use Japanese greetings naturally (おはよう、こんにちは、こんばんは based on context)

When the student tells you their level, acknowledge it enthusiastically and adjust immediately.
When the student says things like "set my level to N3" or "I'm a beginner", update your teaching approach right away and tell them you've noted it.`;
}

export async function askClaude(chatId, userMessage) {
  const user = getUser(chatId);
  const history = getHistory(chatId);

  // Save user message
  saveMessage(chatId, "user", userMessage);

  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1000,
    system: buildSystemPrompt(user),
    messages: [
      ...history,
      { role: "user", content: userMessage }
    ],
  });

  const reply = response.content[0].text;

  // Save assistant reply
  saveMessage(chatId, "assistant", reply);

  return reply;
}

// For scheduled/automated messages (no user input, just a prompt)
export async function generateScheduledMessage(chatId, prompt) {
  const user = getUser(chatId);

  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1000,
    system: buildSystemPrompt(user),
    messages: [{ role: "user", content: prompt }],
  });

  const reply = response.content[0].text;
  saveMessage(chatId, "assistant", reply);
  return reply;
}
