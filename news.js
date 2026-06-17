import Parser from "rss-parser";

const parser = new Parser({
  timeout: 10000,
  headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsBot/1.0)" },
});

// ── 17 topic feeds ────────────────────────────────────
export const TOPIC_FEEDS = {
  vietnam:      { name: "Vietnam",            emoji: "🇻🇳", url: "https://e.vnexpress.net/rss/news.rss" },
  japan:        { name: "Japan & Culture",    emoji: "🇯🇵", url: "https://www.japantimes.co.jp/feed/" },
  us:           { name: "United States",      emoji: "🇺🇸", url: "https://www.pbs.org/newshour/feeds/rss/feeds/headlines" },
  europe:       { name: "Europe",             emoji: "🇪🇺", url: "https://feeds.bbci.co.uk/news/world/europe/rss.xml" },
  china:        { name: "China",              emoji: "🇨🇳", url: "https://www.chinadaily.com.cn/rss/china_rss.xml" },
  india:        { name: "India",              emoji: "🇮🇳", url: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms" },
  korea:        { name: "South Korea",        emoji: "🇰🇷", url: "https://www.koreaherald.com/rss/360000000000.xml" },
  middleeast:   { name: "Middle East",        emoji: "🕌", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  russia:       { name: "Russia",             emoji: "🇷🇺", url: "https://www.themoscowtimes.com/rss/news" },
  australia:    { name: "Australia & NZ",     emoji: "🇦🇺", url: "https://www.abc.net.au/news/feed/2942460/rss.xml" },
  tech:         { name: "Tech & Science",     emoji: "🤖", url: "https://www.wired.com/feed/rss" },
  health:       { name: "Food & Health",      emoji: "🏥", url: "https://rss.nytimes.com/services/xml/rss/nyt/Health.xml" },
  sports:       { name: "Sports",             emoji: "⚽", url: "https://www.skysports.com/rss/12040" },
  fashion:      { name: "Fashion",            emoji: "👗", url: "https://rss.nytimes.com/services/xml/rss/nyt/FashionandStyle.xml" },
  arts:         { name: "Arts",               emoji: "🎨", url: "https://rss.nytimes.com/services/xml/rss/nyt/Arts.xml" },
  entertainment:{ name: "Entertainment",      emoji: "🎬", url: "https://nypost.com/entertainment/feed" },
  lifestyle:    { name: "Lifestyle",          emoji: "✨", url: "https://nypost.com/lifestyle/feed" },
};

// Topic keys in display order for the inline keyboard
export const TOPIC_KEYS = Object.keys(TOPIC_FEEDS);

// ── Fetch a single feed ───────────────────────────────
async function fetchFeed(topicKey, limit = 2) {
  const feed = TOPIC_FEEDS[topicKey];
  if (!feed) return [];
  try {
    const parsed = await parser.parseURL(feed.url);
    return parsed.items.slice(0, limit).map(item => ({
      title:   item.title?.trim() || "No title",
      summary: item.contentSnippet?.slice(0, 300) || item.content?.slice(0, 300) || "",
      link:    item.link || "",
      source:  feed.name,
      topic:   topicKey,
    }));
  } catch (err) {
    console.warn(`⚠️ Failed to fetch ${feed.name}:`, err.message);
    return [];
  }
}

// ── Fetch only the topics that are active (selected by users) ──
export async function fetchActiveTopics(activeTopicKeys) {
  if (!activeTopicKeys || activeTopicKeys.length === 0) return [];

  const results = await Promise.allSettled(
    activeTopicKeys.map(key => fetchFeed(key, 2))
  );

  return results
    .filter(r => r.status === "fulfilled")
    .flatMap(r => r.value)
    .filter(a => a.title);
}

// ── Format raw articles for the Claude generation prompt ──
export function formatArticlesForClaude(articles) {
  return articles.map((a, i) =>
    `${i + 1}. [${a.source}] ${a.title}${a.summary ? ": " + a.summary : ""}`
  ).join("\n");
}
