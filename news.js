import Parser from "rss-parser";

const parser = new Parser({
  timeout: 10000,
  headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsBot/1.0)" },
});

// RSS feeds covering Vietnam, Asia, and global/international news
const FEEDS = [
  // Vietnam & Southeast Asia
  {
    name: "VnExpress News",
    url: "https://vnexpress.net/rss/thoi-su.rss",
    region: "Vietnam",
  },
  {
    name: "SCMP - Asia",
    url: "https://www.scmp.com/rss/5/feed",
    region: "Asia",
  },
  // Global / International Politics
  {
    name: "NY Times World",
    url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
    region: "Global",
  },
  {
    name: "Financial Times World",
    url: "https://www.ft.com/rss/home/international",
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
