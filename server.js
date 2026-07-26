const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PORT = Number(process.env.PORT || 8000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const HANKYUNG_API_KEY =
  "0ZdNlr7LrQoawewqweq78k6usasBsqhqSIaUarSTf8mxnHuQVh9CvKAfpUy94LhBmZMg";
const KOSPD_MAP_BASE_URL = "https://www.kospd.com/maps";
const KOSPD_TERMS = new Set(["1day", "1week", "1month", "3months", "6months", "1year", "ytd"]);
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

const cache = new Map();

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function sendJson(res, status, body) {
  send(res, status, body, { "Content-Type": "application/json; charset=utf-8" });
}

function contentType(filePath) {
  const ext = path.extname(filePath);
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
  }[ext] || "application/octet-stream";
}

async function fetchText(url, options = {}, ttlMs = 0) {
  const cacheKey = options.method || options.body ? `${url}|${options.method || "GET"}|${options.body || ""}` : url;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.time < ttlMs) {
    return cached.text;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 12000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "*/*",
        ...(options.headers || {}),
      },
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const text = await response.text();
    if (ttlMs > 0) {
      cache.set(cacheKey, { text, time: Date.now() });
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}, ttlMs = 0) {
  const text = await fetchText(url, options, ttlMs);
  return JSON.parse(text);
}

function hankyungHeaders(market = "KOSPI") {
  return {
    Authorization: `Bearer ${HANKYUNG_API_KEY}`,
    Accept: "application/json, text/plain, */*",
    Referer: `https://markets.hankyung.com/marketmap/${market.toLowerCase()}`,
  };
}

function formatNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function tradingValueEok(close, volume) {
  const price = formatNumber(close);
  const shares = formatNumber(volume);
  return price != null && shares != null ? (price * shares) / 100000000 : null;
}

function tradingValueUsd(close, volume) {
  const price = formatNumber(close);
  const shares = formatNumber(volume);
  return price != null && shares != null ? price * shares : null;
}

function hankyungHeatColor(rate) {
  const value = Number(rate) || 0;
  if (value >= 5) return "#f3243b";
  if (value >= 2) return "#bd3945";
  if (value > 0) return "#8a414e";
  if (value <= -5) return "#4b87ff";
  if (value <= -2) return "#4675f0";
  if (value < 0) return "#4162c4";
  return "#414654";
}

function kospdHeatColor(rate) {
  const value = Number(rate) || 0;
  if (value >= 3) return "#f3243b";
  if (value >= 2) return "#bd3945";
  if (value > 0) return "#8a414e";
  if (value <= -3) return "#4b87ff";
  if (value <= -2) return "#4675f0";
  if (value < 0) return "#4162c4";
  return "#414654";
}

function parsePercent(value) {
  if (value == null) return null;
  const parsed = Number(String(value).replace(/[%+,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function extractJsValue(text, token) {
  const tokenIndex = text.indexOf(token);
  if (tokenIndex < 0) {
    throw new Error(`${token} not found`);
  }

  const start = text.indexOf("[", tokenIndex);
  if (start < 0) {
    throw new Error(`${token} value not found`);
  }

  let depth = 0;
  let quote = "";
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "[") depth += 1;
    if (char === "]") depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }

  throw new Error(`${token} value is incomplete`);
}

function parseKospdMapData(html) {
  const source = extractJsValue(html, "mapData:");
  const mapData = vm.runInNewContext(`(${source})`, Object.create(null), { timeout: 1000 });
  if (!Array.isArray(mapData) || !mapData[0]) {
    throw new Error("KOSPD mapData is empty");
  }
  return mapData[0];
}

async function getHankyungStockLookup() {
  const markets = [
    ["KOSPI", "1001"],
    ["KOSDAQ", "2001"],
  ];
  const results = await Promise.allSettled(
    markets.map(([symbol, upcode]) =>
      fetchJson(
        `https://markets.hankyung.com/api/v2/stock/filter/stocks?upcode=${upcode}&sortBy=mkt_cap&num=2000`,
        { headers: hankyungHeaders(symbol) },
        60000
      )
    )
  );

  const byName = new Map();
  results.forEach((result, index) => {
    if (result.status !== "fulfilled" || !Array.isArray(result.value)) return;
    const symbol = markets[index][0];
    result.value.forEach((stock) => {
      const name = stock.shname || stock.name;
      if (!name || byName.has(name)) return;
      byName.set(name, { ...stock, sourceMarket: symbol });
    });
  });
  return byName;
}

function buildKospdMap(trace, stockLookup, term, sourceUrl, marketFilter = "") {
  const labels = trace.labels || [];
  const parents = trace.parents || [];
  const values = trace.values || [];
  const colors = trace.marker?.colors || [];
  const custom = trace.customdata || [];
  const groups = new Map();

  labels.forEach((label, index) => {
    const parent = parents[index];
    if (!parent) return;

    const matched = stockLookup.get(label);
    if (marketFilter && matched?.sourceMarket !== marketFilter) return;
    const trader = matched?.stock_trader || {};
    const rate = formatNumber(colors[index]) ?? parsePercent(custom[index]) ?? 0;
    const marketCap = formatNumber(values[index]) ?? formatNumber(trader.mkt_cap ?? matched?.mkt_cap) ?? 0;
    const group = groups.get(parent) || {
      name: parent,
      upcode: parent,
      type: "industry",
      children: [],
    };

    const close = formatNumber(trader.curprc ?? matched?.close_1dy ?? matched?.baseprc);
    const volume = formatNumber(trader.volume || matched?.prevol);

    group.children.push({
      shcode: matched?.shcode || "",
      name: label,
      value: marketCap,
      chgrate: rate,
      chgprc: formatNumber(trader.chgprc),
      date: trader.workdate || "",
      volume,
      tradingValue: tradingValueEok(close, volume),
      close,
      previous: formatNumber(matched?.close_1dy ?? matched?.preprice ?? matched?.baseprc),
      open: formatNumber(trader.openprc),
      high: formatNumber(trader.highprc),
      low: formatNumber(trader.lowprc),
      sourceMarket: matched?.sourceMarket || "KRX300",
      fill: kospdHeatColor(rate),
      type: "stock",
    });

    groups.set(parent, group);
  });

  const children = Array.from(groups.values())
    .map((group) => ({
      ...group,
      children: group.children.sort((a, b) => b.value - a.value),
    }))
    .filter((group) => group.children.length)
    .sort(
      (a, b) =>
        b.children.reduce((sum, stock) => sum + stock.value, 0) -
        a.children.reduce((sum, stock) => sum + stock.value, 0)
    );

  return {
    name: marketFilter ? `KOSPD ${marketFilter}` : "KOSPD KRX 300",
    header: term,
    id: `KOSPD-${marketFilter || "KRX300"}-${term.toUpperCase()}`,
    symbol: marketFilter || "KRX300",
    source: "KOSPD",
    sourceUrl,
    children,
  };
}

function normalizeKospdMap(trace, stockLookup, term, sourceUrl, marketFilter = "") {
  const filtered = buildKospdMap(trace, stockLookup, term, sourceUrl, marketFilter);
  if (!marketFilter || filtered.children.length) return filtered;

  const unfiltered = buildKospdMap(trace, stockLookup, term, sourceUrl, "");
  return {
    ...unfiltered,
    name: `KOSPD ${marketFilter}`,
    id: `KOSPD-${marketFilter}-${term.toUpperCase()}-FALLBACK`,
    symbol: marketFilter,
    coverage: "KRX300",
  };
}

function normalizeKoreaMap(symbol, industries, stocks) {
  const industryNames = new Map(
    industries.map((industry) => [String(industry.upcode), industry.name || industry.hname])
  );
  const groups = new Map();

  stocks.forEach((stock) => {
    const trader = stock.stock_trader || {};
    const upcode = String(stock.upcode || stock.upcode_m || "ETC");
    const industryName = industryNames.get(upcode) || stock.industry || "기타";
    const group = groups.get(upcode) || {
      name: industryName,
      upcode,
      type: "industry",
      children: [],
    };

    const close = formatNumber(trader.curprc ?? stock.close_1dy ?? stock.baseprc);
    const previous = formatNumber(stock.close_1dy ?? stock.preprice ?? stock.baseprc);
    const change = formatNumber(trader.chgprc);
    const rate = formatNumber(trader.chgrate);
    const marketCap = formatNumber(trader.mkt_cap ?? stock.mkt_cap);
    const volume = formatNumber(trader.volume || stock.prevol);

    group.children.push({
      shcode: stock.shcode,
      name: stock.shname,
      value: marketCap || 0,
      chgrate: rate || 0,
      chgprc: change,
      date: trader.workdate || stock.workdate,
      volume,
      tradingValue: tradingValueEok(close, volume),
      close,
      previous,
      open: formatNumber(trader.openprc),
      high: formatNumber(trader.highprc),
      low: formatNumber(trader.lowprc),
      fill: hankyungHeatColor(rate),
      type: "stock",
    });

    groups.set(upcode, group);
  });

  const children = Array.from(groups.values())
    .map((group) => ({
      ...group,
      children: group.children.sort((a, b) => b.value - a.value),
    }))
    .filter((group) => group.children.length)
    .sort(
      (a, b) =>
        b.children.reduce((sum, stock) => sum + stock.value, 0) -
        a.children.reduce((sum, stock) => sum + stock.value, 0)
    );

  return {
    name: "마켓Map",
    header: "",
    id: "마켓Map",
    symbol,
    children,
  };
}

function parseKoreaMarket(value) {
  const market = String(value || "KOSPI").toUpperCase();
  if (market === "KRX300") return "KRX300";
  return market === "KOSDAQ" ? "KOSDAQ" : "KOSPI";
}

function parseKospdTerm(value) {
  const term = String(value || "1day").toLowerCase();
  return KOSPD_TERMS.has(term) ? term : "1day";
}

async function getKoreaMap(res, market, termValue) {
  const symbol = parseKoreaMarket(market);
  const term = parseKospdTerm(termValue);
  if (symbol === "KRX300" || term !== "1day") {
    const sourceUrl = `${KOSPD_MAP_BASE_URL}/${term}`;
    const [html, stockLookup] = await Promise.all([
      fetchText(sourceUrl, { headers: { Referer: "https://www.kospd.com/" } }, 5000),
      getHankyungStockLookup(),
    ]);
    sendJson(
      res,
      200,
      normalizeKospdMap(parseKospdMapData(html), stockLookup, term, sourceUrl, symbol === "KRX300" ? "" : symbol)
    );
    return;
  }

  const upcode = symbol === "KOSDAQ" ? "2001" : "1001";
  try {
    const [industries, stocks] = await Promise.all([
      fetchJson(`https://markets.hankyung.com/api/v2/index/symb/${symbol}/industries`, {
        headers: hankyungHeaders(symbol),
      }, 2500),
      fetchJson(
        `https://markets.hankyung.com/api/v2/stock/filter/stocks?upcode=${upcode}&sortBy=mkt_cap&num=2000`,
        { headers: hankyungHeaders(symbol) },
        2500
      ),
    ]);
    const normalized = normalizeKoreaMap(symbol, industries, stocks);
    if (normalized.children.length) {
      sendJson(res, 200, normalized);
      return;
    }
  } catch (error) {
    // Holidays or upstream maintenance can make the daily Hankyung map unavailable.
  }

  const sourceUrl = `${KOSPD_MAP_BASE_URL}/1day`;
  const [html, stockLookup] = await Promise.all([
    fetchText(sourceUrl, { headers: { Referer: "https://www.kospd.com/" } }, 5000),
    getHankyungStockLookup(),
  ]);
  sendJson(res, 200, normalizeKospdMap(parseKospdMapData(html), stockLookup, "1day", sourceUrl, symbol));
}

async function getKoreaStock(res, code) {
  if (!/^[0-9A-Z]{5,6}$/.test(code)) {
    sendJson(res, 400, { error: "잘못된 종목 코드입니다." });
    return;
  }

  const data = await fetchJson(
    `https://markets.hankyung.com/api/v2/stock/${encodeURIComponent(code)}/detail`,
    { headers: hankyungHeaders() },
    2500
  );
  sendJson(res, 200, data);
}

function normalizeKoreaStockSnapshot(stock = {}, fallback = {}) {
  const trader = stock.stock_trader || fallback.stock_trader || {};
  const close = formatNumber(trader.curprc ?? stock.close_1dy ?? stock.baseprc ?? fallback.close_1dy ?? fallback.baseprc ?? fallback.close);
  const volume = formatNumber(trader.volume ?? stock.prevol ?? fallback.prevol ?? fallback.volume);
  return {
    shcode: stock.shcode || fallback.shcode || "",
    name: stock.shname || stock.name || fallback.shname || fallback.name || "",
    value: formatNumber(trader.mkt_cap ?? stock.mkt_cap ?? fallback.mkt_cap ?? fallback.value),
    chgrate: formatNumber(trader.chgrate ?? fallback.chgrate),
    chgprc: formatNumber(trader.chgprc ?? fallback.chgprc),
    date: trader.workdate || stock.workdate || fallback.workdate || fallback.date || "",
    volume,
    tradingValue: formatNumber(fallback.tradingValue) ?? tradingValueEok(close, volume),
    close,
    previous: formatNumber(stock.close_1dy ?? stock.preprice ?? stock.baseprc ?? fallback.close_1dy ?? fallback.preprice ?? fallback.previous),
    open: formatNumber(trader.openprc ?? fallback.open),
    high: formatNumber(trader.highprc ?? fallback.high),
    low: formatNumber(trader.lowprc ?? fallback.low),
  };
}

function parsePlainNumber(value) {
  if (value == null) return null;
  const parsed = Number(String(value).replace(/[,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNaverMarketCapToEok(value) {
  const text = String(value || "").replace(/,/g, "");
  if (!text) return null;
  const jo = Number((text.match(/([\d.]+)\s*조/) || [])[1] || 0);
  const eok = Number((text.match(/([\d.]+)\s*억/) || [])[1] || 0);
  const total = jo * 10000 + eok;
  return Number.isFinite(total) && total > 0 ? total : parsePlainNumber(text);
}

function naverInfoValue(integration, code) {
  return (integration?.totalInfos || []).find((item) => item.code === code)?.value;
}

async function fetchNaverKoreaStockByName(name) {
  const search = await fetchJson(
    `https://m.stock.naver.com/front-api/search/autoComplete?query=${encodeURIComponent(name)}&target=stock,index,marketindicator,coin,ipo`,
    {
      headers: {
        Accept: "application/json, text/plain, */*",
        Referer: "https://m.stock.naver.com/",
      },
      timeout: 10000,
    },
    30000
  );
  const items = search?.result?.items || search?.items || [];
  const normalizeName = (value) => String(value || "").replace(/\s+/g, "").toUpperCase();
  const item = items.find((entry) =>
    /^\d{6}$/.test(String(entry.code || "")) &&
    (normalizeName(entry.name) === normalizeName(name) || /코스피|코스닥/i.test(entry.typeName || ""))
  ) || items.find((entry) => /^\d{6}$/.test(String(entry.code || "")));
  if (!item?.code) return null;

  const [realtimeResult, integrationResult] = await Promise.allSettled([
    fetchJson(
      `https://polling.finance.naver.com/api/realtime/domestic/stock/${encodeURIComponent(item.code)}`,
      {
        headers: {
          Accept: "application/json, text/plain, */*",
          Referer: "https://m.stock.naver.com/",
        },
        timeout: 10000,
      },
      10000
    ),
    fetchJson(
      `https://m.stock.naver.com/api/stock/${encodeURIComponent(item.code)}/integration`,
      {
        headers: {
          Accept: "application/json, text/plain, */*",
          Referer: "https://m.stock.naver.com/",
        },
        timeout: 10000,
      },
      30000
    ),
  ]);
  const realtime = realtimeResult.status === "fulfilled" ? realtimeResult.value?.datas?.[0] : {};
  const integration = integrationResult.status === "fulfilled" ? integrationResult.value : {};
  const marketCap = parseNaverMarketCapToEok(naverInfoValue(integration, "marketValue"));
  const close = parsePlainNumber(realtime.closePrice);
  const volume = parsePlainNumber(realtime.accumulatedTradingVolume);

  return {
    shcode: item.code,
    name: integration.stockName || realtime.stockName || item.name || name,
    value: marketCap,
    chgrate: parsePlainNumber(realtime.fluctuationsRatio),
    chgprc: parsePlainNumber(realtime.compareToPreviousClosePrice),
    date: realtime.localTradedAt || "",
    volume,
    tradingValue: tradingValueEok(close, volume),
    close,
    previous: parsePlainNumber(naverInfoValue(integration, "lastClosePrice")),
    open: parsePlainNumber(realtime.openPrice || naverInfoValue(integration, "openPrice")),
    high: parsePlainNumber(realtime.highPrice || naverInfoValue(integration, "highPrice")),
    low: parsePlainNumber(realtime.lowPrice || naverInfoValue(integration, "lowPrice")),
  };
}

async function getKoreaStockByName(res, name) {
  const target = String(name || "").trim();
  if (!target || target.length > 40) {
    sendJson(res, 400, { error: "잘못된 종목명입니다." });
    return;
  }

  const normalizeName = (value) => String(value || "").replace(/\s+/g, "").toUpperCase();
  const lookup = await getHankyungStockLookup();
  const matched = lookup.get(target) ||
    Array.from(lookup.values()).find((stock) => normalizeName(stock.shname || stock.name) === normalizeName(target));

  if (!matched) {
    const naverStock = await fetchNaverKoreaStockByName(target);
    if (naverStock) {
      sendJson(res, 200, { source: "Naver", stock: naverStock });
      return;
    }
    sendJson(res, 404, { error: "종목을 찾지 못했습니다." });
    return;
  }

  let detailStock = matched;
  if (matched.shcode) {
    try {
      const detail = await fetchJson(
        `https://markets.hankyung.com/api/v2/stock/${encodeURIComponent(matched.shcode)}/detail`,
        { headers: hankyungHeaders(matched.sourceMarket || "KOSPI") },
        2500
      );
      detailStock = detail.stock || matched;
    } catch (error) {
      detailStock = matched;
    }
  }

  sendJson(res, 200, {
    source: "Hankyung",
    stock: normalizeKoreaStockSnapshot(detailStock, matched),
  });
}

function parseStooqQuote(csv, symbol) {
  const parts = csv.trim().split(",");
  if (parts.length < 9 || parts.includes("N/D")) {
    return { symbol, available: false };
  }

  const close = formatNumber(parts[6]);
  const previous = formatNumber(parts[8]);
  const change = close != null && previous != null ? close - previous : null;
  const changeRate = change != null && previous ? (change / previous) * 100 : null;

  return {
    symbol,
    date: parts[1],
    time: parts[2],
    open: formatNumber(parts[3]),
    high: formatNumber(parts[4]),
    low: formatNumber(parts[5]),
    close,
    volume: formatNumber(parts[7]),
    previous,
    change,
    changeRate,
    tradingValue: tradingValueUsd(close, formatNumber(parts[7])),
    available: true,
  };
}

async function fetchTradingViewQuotes(tickers) {
  const data = await fetchJson(
    "https://scanner.tradingview.com/global/scan",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://www.tradingview.com",
        Referer: "https://www.tradingview.com/",
      },
      body: JSON.stringify({
        symbols: { tickers },
        columns: ["close", "change", "change_abs"],
      }),
    },
    1500
  );

  const quotes = new Map();
  (data.data || []).forEach((row) => {
    quotes.set(row.s, row.d || []);
  });
  return quotes;
}

async function fetchTradingViewStockQuote(symbol) {
  const clean = symbol.toUpperCase().replace(".", "-");
  const tickers = [`NASDAQ:${clean}`, `NYSE:${clean}`, `AMEX:${clean}`];
  const data = await fetchJson(
    "https://scanner.tradingview.com/america/scan",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://www.tradingview.com",
        Referer: "https://www.tradingview.com/",
      },
      body: JSON.stringify({
        symbols: { tickers },
        columns: ["name", "description", "close", "change", "change_abs", "volume", "market_cap_basic"],
      }),
    },
    1500
  );

  const row = (data.data || []).find((item) => Array.isArray(item.d) && item.d[1] != null);
  if (!row) return null;
  const values = row.d || [];
  return {
    name: values[1] || values[0] || symbol,
    shortName: values[0] || symbol,
    close: formatNumber(values[2]),
    changeRate: formatNumber(values[3]),
    change: formatNumber(values[4]),
    volume: formatNumber(values[5]),
    marketCap: formatNumber(values[6]),
    tradingValue: tradingValueUsd(values[2], values[5]),
    exchange: String(row.s || "").split(":")[0],
    available: true,
  };
}

function tradingViewIndex(name, quotes, symbol) {
  const row = quotes.get(symbol);
  if (!row) {
    return { name, close: null, change: null, changeRate: null, available: false };
  }

  return {
    name,
    close: formatNumber(row[0]),
    changeRate: formatNumber(row[1]),
    change: formatNumber(row[2]),
    available: row[0] != null,
  };
}

async function getIndices(res) {
  const [summaryResult, tvResult] = await Promise.allSettled([
    fetchJson("https://markets.hankyung.com/api/v2/main/summary-indices", {
      headers: hankyungHeaders(),
    }, 2500),
    fetchTradingViewQuotes(["NASDAQ:IXIC", "CBOE:SPX", "FX_IDC:USDKRW"]),
  ]);
  const summary = summaryResult.status === "fulfilled" && Array.isArray(summaryResult.value)
    ? summaryResult.value
    : [];
  const tvQuotes = tvResult.status === "fulfilled" ? tvResult.value : new Map();

  const kospi = summary.find((item) => item.upcode === "1001" || item.hname === "코스피");
  const kosdaq = summary.find((item) => item.upcode === "2001" || item.hname === "코스닥");
  const kospiTrader = kospi && (kospi.index_trader_delay || kospi.index_trader);
  const kosdaqTrader = kosdaq && (kosdaq.index_trader_delay || kosdaq.index_trader);

  const koreaIndex = (name, trader) => ({
    name,
    close: trader ? formatNumber(trader.curprc) : null,
    change: trader ? formatNumber(trader.chgprc) : null,
    changeRate: trader ? formatNumber(trader.chgrate) : null,
    date: trader ? trader.workdate : null,
    time: trader ? trader.timestamp : null,
    available: Boolean(trader),
  });

  sendJson(res, 200, {
    kospi: koreaIndex("KOSPI", kospiTrader),
    kosdaq: koreaIndex("KOSDAQ", kosdaqTrader),
    usdkrw: tradingViewIndex("USD/KRW", tvQuotes, "FX_IDC:USDKRW"),
    nasdaq: tradingViewIndex("Nasdaq", tvQuotes, "NASDAQ:IXIC"),
    sp500: tradingViewIndex("S&P 500", tvQuotes, "CBOE:SPX"),
    updatedAt: new Date().toISOString(),
  });
}

async function getUsStock(res, ticker) {
  const symbol = ticker.toUpperCase().replace(/[^A-Z.-]/g, "");
  if (!symbol || symbol.length > 12) {
    sendJson(res, 400, { error: "잘못된 티커입니다." });
    return;
  }

  const [stooqResult, tvResult] = await Promise.allSettled([
    fetchText(
      `https://stooq.com/q/l/?s=${encodeURIComponent(`${symbol.toLowerCase().replace(".", "-")}.us`)}&f=sd2t2ohlcvp&e=csv`,
      {},
      2500
    ),
    fetchTradingViewStockQuote(symbol),
  ]);
  const stooqQuote = stooqResult.status === "fulfilled" ? parseStooqQuote(stooqResult.value, symbol) : { symbol, available: false };
  const tvQuote = tvResult.status === "fulfilled" ? tvResult.value : null;
  const quote = {
    ...stooqQuote,
    close: tvQuote?.close ?? stooqQuote.close,
    change: tvQuote?.change ?? stooqQuote.change,
    changeRate: tvQuote?.changeRate ?? stooqQuote.changeRate,
    volume: tvQuote?.volume ?? stooqQuote.volume,
    marketCap: tvQuote?.marketCap ?? null,
    tradingValue: tvQuote?.tradingValue ?? stooqQuote.tradingValue ?? tradingValueUsd(tvQuote?.close ?? stooqQuote.close, tvQuote?.volume ?? stooqQuote.volume),
    name: tvQuote?.name || symbol,
    shortName: tvQuote?.shortName || symbol,
    exchange: tvQuote?.exchange || "",
    available: Boolean(tvQuote?.available || stooqQuote.available),
  };
  sendJson(res, 200, {
    ticker: symbol,
    source: tvQuote ? "TradingView/Stooq" : "Stooq",
    quote,
    finvizUrl: `https://finviz.com/quote.ashx?t=${encodeURIComponent(symbol)}&p=d`,
  });
}

async function getFinvizMap(res) {
  let html = await fetchText("https://finviz.com/map?t=sec&st=d1", {}, 2500);
  html = html
    .replace(
      /<script\b[^>]*>[\s\S]*?<\/script>/gi,
      (block) =>
        /google|googletagmanager|googlesyndication|googleadservices|doubleclick|gstatic|adsbygoogle|accounts\.google|gtm\.js|admiral|urbanlaurel|__tcfapi|__gpp|pubads|candidate\.dismissed|cmp\.loaded/i.test(block)
          ? ""
          : block
    )
    .replace(
      /<iframe\b[^>]*(?:google|googletagmanager|googlesyndication|googleadservices|doubleclick|gstatic|accounts\.google|__tcfapi|__gpp|admiral)[\s\S]*?<\/iframe>/gi,
      ""
    )
    .replace(/Your browser blocks cookies and\/or local storage, some page functionality might be unavailable\./gi, "")
    .replace(/<ins\b[^>]*class=["'][^"']*adsbygoogle[^"']*["'][\s\S]*?<\/ins>/gi, "")
    .replace(/<a\b[^>]*href=["'][^"']*\/(?:login|register)[^"']*["'][\s\S]*?<\/a>/gi, "");

  const inject = `
<base href="https://finviz.com/">
<script>
(function () {
  var noopPromise = function () { return Promise.resolve(); };
  window.openEliteFeaturesDialog = noopPromise;
  window.openLoginDialog = noopPromise;
  window.openRegisterDialog = noopPromise;
  window.openNewsletterDialog = noopPromise;
  window.openGenericAlertDialog = noopPromise;
  window.openGenericConfirmDialog = noopPromise;
  window.openGenericPromptDialog = noopPromise;
  window.showFailureNotification = function () {};
  window.showSuccessNotification = function () {};
  window.showDefaultNotification = function () {};

  try {
    document.cookie = "notice-newsletter=hide; path=/; domain=.finviz.com; max-age=31536000; SameSite=Lax";
    localStorage.setItem("notice-newsletter", "hide");
    localStorage.setItem("eliteFeaturesDialogShown", "1");
  } catch (error) {}

  function clearBlockingUi() {
    var selectors = [
      "#modal-elite-ad",
      "[id*='login' i]",
      "[class*='login' i]",
      "[id*='newsletter' i]",
      "[class*='newsletter' i]",
      "[id*='google' i]",
      "[class*='google' i]",
      "[id*='credential' i]",
      "[class*='credential' i]",
      "[id*='g_id' i]",
      "iframe[src*='google' i]",
      "iframe[src*='accounts' i]",
      "iframe[src*='doubleclick' i]",
      "[id*='elite' i][id*='modal' i]",
      "[class*='elite' i][class*='modal' i]",
      "[role='dialog']",
      ".fv-dialog",
      ".modal-elite",
      ".modal-backdrop"
    ];
    selectors.forEach(function (selector) {
      document.querySelectorAll(selector).forEach(function (node) {
        node.remove();
      });
    });
    if (document.body) {
      document.body.classList.remove("overflow-hidden", "modal-open");
      document.body.style.overflow = "auto";
    }
    clearStorageWarning();
  }

  function clearStorageWarning() {
    if (!document.body) return;
    var warning = "Your browser blocks cookies and/or local storage";
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var nodes = [];
    while (walker.nextNode()) {
      if ((walker.currentNode.nodeValue || "").indexOf(warning) >= 0) {
        nodes.push(walker.currentNode);
      }
    }
    nodes.forEach(function (node) {
      var parent = node.parentElement;
      var box = parent && parent.closest("div, section, article, aside, p, span");
      if (box && box !== document.body) {
        box.remove();
      } else {
        node.nodeValue = "";
      }
    });
  }

  function showHeatMapOnly() {
    var map = document.getElementById("map");
    if (!map) return;

    document.querySelectorAll(".navbar, .map-sidebar, .map-view-switch, .js-map-subheader, .header, .footer").forEach(function (node) {
      node.remove();
    });
    document.querySelectorAll("button").forEach(function (button) {
      var text = (button.textContent || "").trim();
      if (text !== "Fullscreen" && text !== "Share Map") return;
      var bar = button.closest("[class*='border-finviz-blue-gray']") || button.parentElement && button.parentElement.parentElement;
      if (bar) bar.remove();
    });

    document.documentElement.classList.add("heatmap-only");
    document.body.classList.add("heatmap-only");
    map.classList.add("heatmap-only-map");
    window.dispatchEvent(new Event("resize"));
  }

  document.addEventListener("DOMContentLoaded", clearBlockingUi);
  document.addEventListener("DOMContentLoaded", showHeatMapOnly);
  window.addEventListener("load", clearBlockingUi);
  window.addEventListener("load", showHeatMapOnly);
  setInterval(clearBlockingUi, 700);
  setInterval(showHeatMapOnly, 700);
  new MutationObserver(clearBlockingUi).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
</script>
<style>
  html,
  body {
    width: 100% !important;
    height: 100% !important;
    margin: 0 !important;
    overflow: hidden !important;
    background: #0f1117 !important;
  }

  html.heatmap-only,
  body.heatmap-only,
  .content.map {
    width: 100vw !important;
    height: 100vh !important;
    min-height: 100vh !important;
    padding: 0 !important;
    margin: 0 !important;
    overflow: hidden !important;
  }

  #map.heatmap-only-map {
    position: fixed !important;
    inset: 0 !important;
    width: 100vw !important;
    height: 100vh !important;
    min-height: 100vh !important;
    padding: 0 !important;
    margin: 0 !important;
    overflow: hidden !important;
  }

  #map.heatmap-only-map #body,
  #map.heatmap-only-map .relative {
    display: block !important;
    position: relative !important;
    width: 100vw !important;
    height: 100vh !important;
  }

  #map.heatmap-only-map canvas {
    width: 100vw !important;
    height: 100vh !important;
    filter: hue-rotate(-120deg) saturate(1.85) contrast(1.1) brightness(1.04) !important;
  }

  #map.heatmap-only-map .hover-canvas {
    filter: none !important;
  }

  #map.heatmap-only-map #canvas-wrapper > :not(canvas):not(.hover-canvas):not(#hover),
  #map.heatmap-only-map button,
  #map.heatmap-only-map a {
    display: none !important;
  }

  #map.heatmap-only-map #hover {
    z-index: 10 !important;
    filter: hue-rotate(-120deg) saturate(1.85) contrast(1.1) brightness(1.04) !important;
  }

  .navbar,
  .map-sidebar,
  .map-view-switch,
  .js-map-subheader,
  [class*="border-finviz-blue-gray"][class*="bg-"],
  .header,
  .footer,
  .advertisement,
  iframe[src*="google" i],
  iframe[src*="accounts" i],
  iframe[src*="doubleclick" i],
  [id*="google" i],
  [class*="google" i],
  [id*="credential" i],
  [class*="credential" i],
  [id*="g_id" i],
  #modal-elite-ad,
  [id*="login" i],
  [class*="login" i],
  [id*="newsletter" i],
  [class*="newsletter" i],
  [id*="elite" i][id*="modal" i],
  [class*="elite" i][class*="modal" i],
  [role="dialog"],
  .fv-dialog,
  .modal-elite,
  .modal-backdrop {
    display: none !important;
    visibility: hidden !important;
    pointer-events: none !important;
  }
</style>`;
  const clickBridge = `
<script>
(function () {
  function sendTicker(ticker) {
    if (!ticker) return false;
    parent.postMessage({ type: "stock-click", market: "US", symbol: ticker }, "*");
    return true;
  }

  function tickerFromValue(value) {
    var text = String(value || "").replace(/\\s+/g, " ").trim();
    var match = text.match(/[?&]t=([A-Z]{1,6}(?:[.-][A-Z])?)/i);
    if (match) return match[1].toUpperCase().replace("-", ".");
    match = text.match(/^([A-Z]{1,6}(?:[.-][A-Z])?)(?:$|[\\s:|,$()])/);
    if (match) return match[1].replace("-", ".");
    match = text.match(/\\b([A-Z]{1,5}(?:[.-][A-Z])?)\\b(?=\\s+(?:[-+]?\\d|\\$))/);
    return match ? match[1].replace("-", ".") : "";
  }

  function tickerFromHover() {
    var hover = document.getElementById("hover");
    if (!hover) return "";
    return tickerFromValue([
      hover.textContent || "",
      hover.getAttribute("title") || "",
      hover.getAttribute("data-ticker") || ""
    ].join(" "));
  }

  function stockTickerFromHover() {
    var text = hoverText();
    var ticker = tickerFromHover();
    return isStockHover(ticker, text) ? ticker : "";
  }

  function hoverText() {
    var hover = document.getElementById("hover");
    if (!hover) return "";
    return (hover.innerText || hover.textContent || "").trim();
  }

  function isStockHover(ticker, text) {
    if (!ticker || !text) return false;
    if (text.indexOf(ticker) < 0) return false;
    return /[-+]?\\d+(?:\\.\\d+)?%/.test(text) || /\\$\\s*\\d/.test(text);
  }

  function sendHover(event) {
    var text = hoverText();
    var ticker = tickerFromHover();
    if (!isStockHover(ticker, text)) {
      parent.postMessage({ type: "stock-hover-end", market: "US" }, "*");
      return;
    }
    parent.postMessage({
      type: "stock-hover",
      market: "US",
      symbol: ticker,
      text: text,
      x: event.clientX,
      y: event.clientY
    }, "*");
  }

  function pickTicker(target) {
    var node = target;
    while (node && node !== document) {
      var text = (node.textContent || "").trim();
      var title = (node.getAttribute && (node.getAttribute("title") || node.getAttribute("data-ticker"))) || "";
      var href = (node.getAttribute && node.getAttribute("href")) || "";
      var value = title || href || text;
      var ticker = tickerFromValue(value);
      if (ticker) return ticker;
      node = node.parentNode;
    }
    return "";
  }

  var originalOpen = window.open;
  window.open = function (url) {
    if (sendTicker(tickerFromValue(url))) return null;
    return originalOpen.apply(window, arguments);
  };

  document.addEventListener("click", function (event) {
    var ticker = pickTicker(event.target) || stockTickerFromHover();
    if (!ticker) return;
    event.preventDefault();
    event.stopPropagation();
    sendTicker(ticker);
  }, true);

  document.addEventListener("dblclick", function (event) {
    var ticker = pickTicker(event.target) || stockTickerFromHover();
    if (!ticker) return;
    event.preventDefault();
    event.stopPropagation();
    sendTicker(ticker);
  }, true);

  document.addEventListener("mousemove", function (event) {
    var map = document.getElementById("map");
    if (!map || !map.contains(event.target)) return;
    window.setTimeout(function () {
      sendHover(event);
    }, 0);
  }, true);

  document.addEventListener("mouseleave", function () {
    parent.postMessage({ type: "stock-hover-end", market: "US" }, "*");
  }, true);

  document.addEventListener("wheel", function (event) {
    var map = document.getElementById("map");
    if (!map || !map.contains(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "iframe-wheel", deltaY: event.deltaY }, "*");
    } else {
      window.scrollBy(0, event.deltaY);
    }
  }, { capture: true, passive: false });
})();
</script>`;

  html = html
    .replace(/<head([^>]*)>/i, `<head$1>${inject}`)
    .replace(/<\/body>/i, `${clickBridge}</body>`);

  send(res, 200, html, {
    "Content-Type": "text/html; charset=utf-8",
    "X-Frame-Options": "",
    "Content-Security-Policy": [
      "default-src 'self' https://finviz.com https://*.finviz.com",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://finviz.com https://*.finviz.com",
      "style-src 'self' 'unsafe-inline' https://finviz.com https://*.finviz.com",
      "img-src 'self' data: https://finviz.com https://*.finviz.com",
      "font-src 'self' data: https://finviz.com https://*.finviz.com",
      "connect-src 'self' https://finviz.com https://*.finviz.com",
      "frame-src 'none'",
      "child-src 'none'",
      "form-action 'none'",
      "base-uri https://finviz.com",
    ].join("; "),
  });
}

function serveStatic(req, res) {
  const urlPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  const safePath = urlPath === "/" ? "/index.html" : decodeURIComponent(urlPath);
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    send(res, 403, "Forbidden", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, "Not Found", { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }
    send(res, 200, data, { "Content-Type": contentType(filePath) });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === "/api/indices") {
      await getIndices(res);
      return;
    }

    if (url.pathname === "/api/korea-map") {
      await getKoreaMap(res, url.searchParams.get("market"), url.searchParams.get("term"));
      return;
    }

    if (url.pathname.startsWith("/api/korea-stock/")) {
      await getKoreaStock(res, decodeURIComponent(url.pathname.split("/").pop()));
      return;
    }

    if (url.pathname.startsWith("/api/korea-stock-name/")) {
      await getKoreaStockByName(res, decodeURIComponent(url.pathname.split("/").pop()));
      return;
    }

    if (url.pathname.startsWith("/api/us-stock/")) {
      await getUsStock(res, decodeURIComponent(url.pathname.split("/").pop()));
      return;
    }

    if (url.pathname === "/finviz-map") {
      await getFinvizMap(res);
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 502, {
      error: "외부 데이터를 불러오지 못했습니다.",
      detail: error.message,
    });
  }
});

server.listen(PORT, () => {
  console.log(`KOSPI/Nasdaq dashboard running at http://127.0.0.1:${PORT}`);
});
