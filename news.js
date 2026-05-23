import Parser from "rss-parser";

const parser = new Parser({
  timeout: 10000,
  headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsBot/1.0)" },
});

// RSS feeds covering Vietnam, Southeast Asia, and global/international news
const FEEDS = [
  // Vietnam & Southeast Asia
  {
    name: "VnExpress International",
    url: "https://e.vnexpress.net/rss/news.rss",
    region: "Vietnam",
  },
  {
    name: "Tuoi Tre News",
    url: "https://tuoitrenews.vn/rss/news.rss",
    region: "Vietnam",
  },
  {
    name: "Channel NewsAsia - SE Asia",
    url: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=10416",
    region: "Southeast Asia",
  },
  // Global / International Politics
  {
    name: "BBC World",
    url: "https://feeds.bbci.co.uk/news/world/rss.xml",
    region: "Global",
  },
  {
    name: "Reuters World News",
    url: "https://feeds.reuters.com/reuters/worldNews",
    region: "Global",
  },
  {
    name: "Al Jazeera",
    url: "https://www.aljazeera.com/xml/rss/all.xml",
    region: "Global",
  },
];

// Fetch headlines from a single feed, return top N items
async function fetchFeed(feed, limit = 3) {
  try {
    const parsed = await parser.parseURL(feed.url);
    return parsed.items.slice(0, limit).map((item) => ({
      title: item.title?.trim() || "No title",
      summary: item.contentSnippet?.slice(0, 200) || item.content?.slice(0, 200) || "",
      link: item.link || "",
      source: feed.name,
      region: feed.region,
    }));
  } catch (err) {
    console.warn(`⚠️ Failed to fetch ${feed.name}:`, err.message);
    return []; // silently skip failed feeds
  }
}

// Fetch from all feeds, return grouped headlines
export async function fetchTopHeadlines() {
  const results = await Promise.allSettled(
    FEEDS.map((feed) => fetchFeed(feed, 2))
  );

  const allArticles = results
    .filter((r) => r.status === "fulfilled")
    .flatMap((r) => r.value)
    .filter((a) => a.title);

  // Group by region
  const grouped = {
    Vietnam: allArticles.filter((a) => a.region === "Vietnam"),
    "Southeast Asia": allArticles.filter((a) => a.region === "Southeast Asia"),
    Global: allArticles.filter((a) => a.region === "Global"),
  };

  return grouped;
}

// Format headlines into a clean prompt for Claude
export function formatHeadlinesForClaude(grouped) {
  const sections = [];

  for (const [region, articles] of Object.entries(grouped)) {
    if (articles.length === 0) continue;
    const lines = articles.map(
      (a) => `- ${a.title}${a.summary ? ": " + a.summary : ""} [${a.source}]`
    );
    sections.push(`## ${region}\n${lines.join("\n")}`);
  }

  return sections.join("\n\n");
}
