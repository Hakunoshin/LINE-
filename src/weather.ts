// Open-Meteo(APIキー不要・無料)で今日の天気を取得する。
// https://open-meteo.com/

// WMO天気コード → 日本語(絵文字付き)
const WEATHER_CODE_JA: Record<number, string> = {
  0: "☀️ 快晴",
  1: "🌤️ 晴れ",
  2: "⛅ 一部曇り",
  3: "☁️ 曇り",
  45: "🌫️ 霧",
  48: "🌫️ 霧(着氷)",
  51: "🌦️ 弱い霧雨",
  53: "🌦️ 霧雨",
  55: "🌧️ 強い霧雨",
  56: "🌧️ 着氷性の霧雨",
  57: "🌧️ 強い着氷性の霧雨",
  61: "🌦️ 小雨",
  63: "🌧️ 雨",
  65: "🌧️ 強い雨",
  66: "🌧️ 着氷性の雨",
  67: "🌧️ 強い着氷性の雨",
  71: "🌨️ 小雪",
  73: "🌨️ 雪",
  75: "❄️ 大雪",
  77: "🌨️ 霧雪",
  80: "🌦️ にわか雨",
  81: "🌧️ 強いにわか雨",
  82: "⛈️ 激しいにわか雨",
  85: "🌨️ にわか雪",
  86: "❄️ 強いにわか雪",
  95: "⛈️ 雷雨",
  96: "⛈️ 雹を伴う雷雨",
  99: "⛈️ 激しい雹を伴う雷雨",
};

export interface WeatherOptions {
  latitude: number;
  longitude: number;
  locationName: string;
}

/** 今日の天気を1行の日本語文字列で返す。取得失敗時はnull。 */
export async function getTodayWeather(opts: WeatherOptions): Promise<string | null> {
  const params = new URLSearchParams({
    latitude: String(opts.latitude),
    longitude: String(opts.longitude),
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: "Asia/Tokyo",
    forecast_days: "1",
  });
  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;

  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    daily?: {
      weather_code?: number[];
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
      precipitation_probability_max?: number[];
    };
  };
  const d = data.daily;
  if (!d || !d.weather_code || d.weather_code.length === 0) return null;

  const desc = WEATHER_CODE_JA[d.weather_code[0]] ?? "天気不明";
  const max = d.temperature_2m_max?.[0];
  const min = d.temperature_2m_min?.[0];
  const pop = d.precipitation_probability_max?.[0];

  const parts = [`${opts.locationName}: ${desc}`];
  if (max != null && min != null) {
    parts.push(`${Math.round(max)}℃/${Math.round(min)}℃`);
  }
  if (pop != null) {
    parts.push(`降水${pop}%`);
  }
  return parts.join(" ");
}
