// YouTubeチャンネルの最新動画をRSSから取得する(APIキー不要)。
// RSSフィードは最新15本程度を返す。字幕や各回の本文は取得できないため、
// 記事のお題として「タイトル」を使う用途に用いる。

export interface YouTubeVideo {
  videoId: string;
  title: string;
  url: string;
  published: string;
}

const RSS_BASE = "https://www.youtube.com/feeds/videos.xml?channel_id=";

// よく使うHTMLエンティティを元に戻す。
function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// チャンネルの最新動画一覧をRSSから取得する。
export async function fetchChannelVideos(channelId: string): Promise<YouTubeVideo[]> {
  const res = await fetch(`${RSS_BASE}${encodeURIComponent(channelId)}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) {
    throw new Error(`YouTube RSS取得に失敗 (${res.status})`);
  }
  const xml = await res.text();

  const videos: YouTubeVideo[] = [];
  // <entry>...</entry> ごとに分割して、その中のフィールドだけを見る
  // (チャンネル名の<title>を拾わないようにするため)
  const entries = xml.split("<entry>").slice(1);
  for (const entry of entries) {
    const body = entry.split("</entry>")[0];
    const videoId = body.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    const title = body.match(/<title>([^<]*)<\/title>/)?.[1];
    const published = body.match(/<published>([^<]+)<\/published>/)?.[1] ?? "";
    if (videoId && title) {
      videos.push({
        videoId,
        title: decodeEntities(title).trim(),
        url: `https://www.youtube.com/watch?v=${videoId}`,
        published,
      });
    }
  }
  return videos;
}

// 除外リスト(直近使用分)を避けてランダムに1本選ぶ。
// 全部除外対象なら除外を無視して全体から選ぶ。
export function pickRandomVideo(videos: YouTubeVideo[], excludeIds: string[] = []): YouTubeVideo | null {
  if (videos.length === 0) return null;
  const pool = videos.filter((v) => !excludeIds.includes(v.videoId));
  const from = pool.length > 0 ? pool : videos;
  return from[Math.floor(Math.random() * from.length)];
}
