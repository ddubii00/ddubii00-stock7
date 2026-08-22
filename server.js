const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const HANKYUNG_KOSPI_STOCK_CODES_BY_SECTOR = require("./hankyung-kospi-sectors.json");

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

async function fetchDecodedText(url, encoding, options = {}, ttlMs = 0) {
  const cacheKey = `${url}|${encoding}`;
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
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = new TextDecoder(encoding).decode(buffer);
    if (ttlMs > 0) cache.set(cacheKey, { text, time: Date.now() });
    return text;
  } finally {
    clearTimeout(timer);
  }
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

function parseKoreanMoneyToEok(value) {
  const text = String(value || "").replace(/,/g, "").trim();
  if (!text) return null;
  const jo = Number((text.match(/([\d.]+)\s*조/) || [])[1] || 0);
  const eok = Number((text.match(/([\d.]+)\s*억/) || [])[1] || 0);
  if (jo || eok) {
    const total = jo * 10000 + eok;
    return Number.isFinite(total) ? total : null;
  }
  return parsePlainNumber(text);
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

function normalizeKoreaStockName(value) {
  return String(value || "").toUpperCase().replace(/[^0-9A-Z가-힣]/g, "");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNaverMarketRows(html, symbol) {
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  return rows.map((row) => {
    const link = row.match(/\/item\/main\.naver\?code=(\d{6})["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) return null;

    const shcode = link[1];
    const name = stripHtml(link[2]);
    const numbers = [...row.matchAll(/<td[^>]*class=["'][^"']*number[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi)]
      .map((match) => stripHtml(match[1]));
    const close = parsePlainNumber(numbers[0]);
    const rawChange = parsePlainNumber(numbers[1]);
    let rate = parsePercent(numbers[2]);
    const isDown = /nv01|하락|down/i.test(row) || /^-/.test(numbers[2] || "");
    const isUp = /red01|상승|up/i.test(row) || /^\+/.test(numbers[2] || "");
    if (rate != null && isDown) rate = -Math.abs(rate);
    if (rate != null && isUp) rate = Math.abs(rate);
    const chgprc = rawChange == null ? null : isDown ? -Math.abs(rawChange) : rawChange;
    const marketCap = parsePlainNumber(numbers[4]);
    const volume = parsePlainNumber(numbers[7]);

    return {
      shcode,
      name,
      value: marketCap || 0,
      chgrate: rate || 0,
      chgprc,
      date: "",
      volume,
      tradingValue: tradingValueEok(close, volume),
      close,
      previous: close != null && chgprc != null ? close - chgprc : null,
      sourceMarket: symbol,
      fill: hankyungHeatColor(rate),
      type: "stock",
    };
  }).filter(Boolean);
}

const NAVER_SECTOR_RULES = [
  ["전기·전자", ["삼성전자", "SK하이닉스", "LG전자", "삼성전기", "LG이노텍", "리노공업", "심텍", "주성엔지니어링", "원익IPS", "하나마이크론", "ISC", "동진쎄미켐", "이오테크닉스", "HPSP", "테크윙", "칩스앤미디어", "피에스케이", "솔브레인", "반도체", "쎄미", "세미콘", "웨이퍼", "전기", "전자", "일렉트릭", "디스플레이", "OLED", "LED", "파워"]],
  ["제약", ["알테오젠", "HLB", "셀트리온", "리가켐", "삼천당", "휴젤", "삼성바이오", "유한양행", "바이오", "제약", "약품", "메디", "헬스", "랩", "신라젠", "오스코텍", "에스티팜", "케어", "진단", "파마"]],
  ["화학", ["LG화학", "에코프로", "엘앤에프", "천보", "대주전자재료", "포스코퓨처엠", "금양", "배터리", "전지", "소재", "머티리얼", "첨단소재", "양극재", "음극재", "화학", "케미칼", "에너지", "가스", "정유", "S-OIL", "OCI", "솔라", "태양광", "석유"]],
  ["운송장비·부품", ["현대차", "기아", "모비스", "HL만도", "타이어", "오토", "모터", "차", "자동차", "부품"]],
  ["기계·장비", ["두산", "로보", "로봇", "기계", "중공업", "조선", "오션", "로템", "엘리베이터", "산업"]],
  ["금속", ["철강", "스틸", "금속", "아연", "제강", "POSCO", "포스코"]],
  ["증권", ["증권", "투자증권"]],
  ["보험", ["보험", "생명", "화재", "손해"]],
  ["음식료·담배", ["식품", "푸드", "음료", "담배", "농심", "오리온", "CJ제일제당", "하이트", "롯데칠성"]],
  ["섬유·의류", ["섬유", "의류", "패션", "F&F", "한섬", "영원무역"]],
  ["비금속", ["비금속", "시멘트", "유리", "세라믹"]],
  ["의료·정밀기기", ["정밀", "의료기기", "덴티움", "클래시스", "레이", "뷰웍스"]],
  ["종이·목재", ["종이", "목재", "제지", "페이퍼"]],
];

// Hankyung's stock feed carries the complete KOSPI classification in `upcode`.
// Its industries endpoint only lists manufacturing groups, so seed the omitted
// service-sector names here before merging the live industry response.
const HANKYUNG_KOSPI_INDUSTRY_NAMES = new Map([
  ["1001", "어업"],
  ["1005", "음식료·담배"],
  ["1006", "섬유·의류"],
  ["1007", "종이·목재"],
  ["1008", "화학"],
  ["1009", "제약"],
  ["1010", "비금속"],
  ["1011", "금속"],
  ["1012", "기계·장비"],
  ["1013", "전기·전자"],
  ["1014", "의료·정밀기기"],
  ["1015", "운송장비·부품"],
  ["1016", "유통"],
  ["1017", "전기·가스"],
  ["1018", "건설"],
  ["1019", "운송·창고"],
  ["1020", "통신"],
  ["1021", "금융"],
  ["1024", "증권"],
  ["1025", "보험"],
  ["1026", "일반서비스"],
  ["1027", "기타제조"],
  ["1045", "부동산"],
  ["1046", "IT 서비스"],
  ["1047", "오락·문화"],
]);
const HANKYUNG_KOSPI_STOCK_SECTOR_BY_CODE = new Map(
  Object.entries(HANKYUNG_KOSPI_STOCK_CODES_BY_SECTOR).flatMap(([sector, codes]) =>
    codes.map((code) => [code, sector])
  )
);

function canonicalKoreaSectorName(name, stock = {}) {
  const code = String(stock.shcode || stock.code || stock.symbol || "").replace(/\D/g, "");
  const stockName = normalizeKoreaStockName(stock.shname || stock.name || "");
  if (["005930", "000660"].includes(code) || ["삼성전자", "SK하이닉스"].includes(stockName)) {
    return "전기·전자";
  }

  const normalized = String(name || "")
    .replace(/[\s·.ㆍ/()_-]+/g, "")
    .toLowerCase();
  if (["전기전자", "전기전자제품", "반도체", "반도체와반도체장비"].includes(normalized)) {
    return "전기·전자";
  }
  return String(name || "").trim() || "기타";
}

function inferNaverSector(stock, stockLookup = new Map()) {
  const matched = stockLookup.get(stock.shcode) ||
    stockLookup.get(stock.name) ||
    stockLookup.get(normalizeKoreaStockName(stock.name));
  if (matched?.industry) return canonicalKoreaSectorName(matched.industry, stock);
  const snapshotSector = HANKYUNG_KOSPI_STOCK_SECTOR_BY_CODE.get(String(stock.shcode || ""));
  if (snapshotSector) return snapshotSector;

  const normalized = normalizeKoreaStockName(stock.name);
  const rawName = String(stock.name || "").toUpperCase();
  const rule = NAVER_SECTOR_RULES.find(([, keywords]) =>
    keywords.some((keyword) => normalized.includes(normalizeKoreaStockName(keyword)) || rawName.includes(String(keyword).toUpperCase()))
  );
  return canonicalKoreaSectorName(rule ? rule[0] : "기타", stock);
}

function groupNaverStocksBySector(stocks, stockLookup = new Map()) {
  const groups = new Map();
  stocks.forEach((stock) => {
    const sectorName = inferNaverSector(stock, stockLookup);
    const group = groups.get(sectorName) || {
      name: sectorName,
      upcode: sectorName,
      type: "industry",
      children: [],
    };
    group.children.push(stock);
    groups.set(sectorName, group);
  });

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      children: group.children.sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0)),
    }))
    .sort(
      (a, b) =>
        b.children.reduce((sum, stock) => sum + (Number(stock.value) || 0), 0) -
        a.children.reduce((sum, stock) => sum + (Number(stock.value) || 0), 0)
    );
}

async function fetchNaverMarketMap(symbol, stockLookup = new Map()) {
  const sosok = symbol === "KOSDAQ" ? 1 : 0;
  const pages = Array.from({ length: 12 }, (_, index) => index + 1);
  const results = await Promise.allSettled(
    pages.map((page) =>
      fetchDecodedText(
        `https://finance.naver.com/sise/sise_market_sum.naver?sosok=${sosok}&page=${page}`,
        "euc-kr",
        { headers: { Referer: "https://finance.naver.com/" }, timeout: 7000 },
        30000
      )
    )
  );

  const byCode = new Map();
  results.forEach((result) => {
    if (result.status !== "fulfilled") return;
    parseNaverMarketRows(result.value, symbol).forEach((stock) => {
      if (!byCode.has(stock.shcode)) byCode.set(stock.shcode, stock);
    });
  });
  const stocks = Array.from(byCode.values()).sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
  return {
    name: `Naver ${symbol}`,
    header: "1day",
    id: `NAVER-${symbol}-1DAY`,
    symbol,
    source: "Naver",
    children: groupNaverStocksBySector(stocks, stockLookup),
  };
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

function buildHankyungIndustryMap(industries = []) {
  const map = new Map(HANKYUNG_KOSPI_INDUSTRY_NAMES);
  (Array.isArray(industries) ? industries : []).forEach((industry) => {
    const name = industry.name || industry.hname || industry.korName || "";
    if (!name) return;
    [industry.upcode_m, industry.upcode, industry.code, industry.industry_code]
      .map((code) => String(code || ""))
      .filter(Boolean)
      .forEach((code) => {
        if (!map.has(code)) map.set(code, name);
      });
  });
  return map;
}

function hankyungIndustryCodes(stock = {}) {
  return [
    stock.upcode_m,
    stock.industry_code,
    stock.industryCode,
    stock.bstp_code,
    stock.bstpCode,
    stock.upcode,
  ]
    .map((code) => String(code || ""))
    .filter((code) => code && code !== "2001");
}

function hankyungIndustryName(stock, industryMap) {
  const matchedCode = hankyungIndustryCodes(stock).find((code) => industryMap.get(code));
  const snapshotSector = HANKYUNG_KOSPI_STOCK_SECTOR_BY_CODE.get(String(stock.shcode || ""));
  const name = industryMap.get(matchedCode) || snapshotSector ||
    stock?.industry || stock?.industryName || stock?.sector || "";
  return canonicalKoreaSectorName(name, stock);
}

async function getHankyungStockLookup() {
  const markets = [
    ["KOSPI", "1001"],
    ["KOSDAQ", "2001"],
  ];
  const results = await Promise.allSettled(
    markets.map(async ([symbol, upcode]) => {
      const [industries, stocks] = await Promise.all([
        fetchJson(`https://markets.hankyung.com/api/v2/index/symb/${symbol}/industries`, {
          headers: hankyungHeaders(symbol),
          timeout: 7000,
        }, 60000),
        fetchJson(
          `https://markets.hankyung.com/api/v2/stock/filter/stocks?upcode=${upcode}&sortBy=mkt_cap&num=2000`,
          { headers: hankyungHeaders(symbol), timeout: 7000 },
          60000
        ),
      ]);
      return { symbol, industryMap: buildHankyungIndustryMap(industries), stocks };
    })
  );

  const byName = new Map();
  results.forEach((result) => {
    if (result.status !== "fulfilled" || !Array.isArray(result.value.stocks)) return;
    const { symbol, industryMap, stocks } = result.value;
    stocks.forEach((stock) => {
      const name = stock.shname || stock.name;
      if (!name) return;
      const normalized = normalizeKoreaStockName(name);
      const industry = hankyungIndustryName(stock, industryMap);
      const industryUpcode = hankyungIndustryCodes(stock).find((code) => industryMap.get(code)) || "";
      const value = { ...stock, industry, industryUpcode, sourceMarket: symbol };
      if (!byName.has(name)) byName.set(name, value);
      if (normalized && !byName.has(normalized)) byName.set(normalized, value);
      if (stock.shcode && !byName.has(stock.shcode)) byName.set(stock.shcode, value);
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

    const matched = stockLookup.get(label) || stockLookup.get(normalizeKoreaStockName(label));
    if (marketFilter && matched?.sourceMarket !== marketFilter) return;
    const trader = matched?.stock_trader || {};
    const rate = formatNumber(colors[index]) ?? parsePercent(custom[index]) ?? 0;
    const traceMarketCap = formatNumber(values[index]);
    const marketCap = traceMarketCap != null
      ? traceMarketCap / 100000000
      : formatNumber(trader.mkt_cap ?? matched?.mkt_cap) ?? 0;
    const groupName = canonicalKoreaSectorName(matched?.industry || parent, {
      ...matched,
      name: label,
    });
    const groupKey = groupName || parent;
    const group = groups.get(groupKey) || {
      name: groupName,
      upcode: matched?.industryUpcode || parent,
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

    groups.set(groupKey, group);
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
  return filtered;
}

function normalizeKoreaMap(symbol, industries, stocks) {
  const industryNames = buildHankyungIndustryMap(industries);
  const groups = new Map();

  stocks.forEach((stock) => {
    const trader = stock.stock_trader || {};
    const upcode = hankyungIndustryCodes(stock).find((code) => industryNames.get(code)) ||
      String(stock.upcode || stock.upcode_m || "ETC");
    const industryName = canonicalKoreaSectorName(hankyungIndustryName(stock, industryNames), stock);
    const groupKey = industryName || upcode;
    const group = groups.get(groupKey) || {
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

    groups.set(groupKey, group);
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
      fetchText(sourceUrl, { headers: { Referer: "https://www.kospd.com/" }, timeout: 5000 }, 5000),
      getHankyungStockLookup(),
    ]);
    const normalized = normalizeKospdMap(
      parseKospdMapData(html),
      stockLookup,
      term,
      sourceUrl,
      symbol === "KRX300" ? "" : symbol
    );
    if (symbol !== "KRX300" && !normalized.children.length) {
      throw new Error(`${symbol} map is empty`);
    }
    sendJson(res, 200, await enrichKoreaMapWithRealtime(normalized, { preserveRate: term !== "1day" }));
    return;
  }

  const upcode = symbol === "KOSDAQ" ? "2001" : "1001";
  try {
    const [industries, stocks] = await Promise.all([
      fetchJson(`https://markets.hankyung.com/api/v2/index/symb/${symbol}/industries`, {
        headers: hankyungHeaders(symbol),
        timeout: 7000,
      }, 2500),
      fetchJson(
        `https://markets.hankyung.com/api/v2/stock/filter/stocks?upcode=${upcode}&sortBy=mkt_cap&num=2000`,
        { headers: hankyungHeaders(symbol), timeout: 7000 },
        2500
      ),
    ]);
    const normalized = normalizeKoreaMap(symbol, industries, stocks);
    if (normalized.children.length) {
      sendJson(res, 200, await enrichKoreaMapWithRealtime(normalized));
      return;
    }
  } catch (error) {
    try {
      let stockLookup = new Map();
      try {
        stockLookup = await getHankyungStockLookup();
      } catch {
        stockLookup = new Map();
      }
      const naverMap = await fetchNaverMarketMap(symbol, stockLookup);
      if (naverMap.children.length) {
        sendJson(res, 200, await enrichKoreaMapWithRealtime(naverMap));
        return;
      }
    } catch (naverError) {
      // Holidays or upstream maintenance can make the daily Hankyung map unavailable.
    }
  }

  const sourceUrl = `${KOSPD_MAP_BASE_URL}/1day`;
  const [html, stockLookup] = await Promise.all([
    fetchText(sourceUrl, { headers: { Referer: "https://www.kospd.com/" }, timeout: 5000 }, 5000),
    getHankyungStockLookup(),
  ]);
  const normalized = normalizeKospdMap(parseKospdMapData(html), stockLookup, "1day", sourceUrl, symbol);
  if (!normalized.children.length) {
    throw new Error(`${symbol} map is empty`);
  }
  sendJson(res, 200, await enrichKoreaMapWithRealtime(normalized));
}

async function getKoreaStock(res, code) {
  if (!/^[0-9A-Z]{5,6}$/.test(code)) {
    sendJson(res, 400, { error: "잘못된 종목 코드입니다." });
    return;
  }

  const data = await fetchJson(
    `https://markets.hankyung.com/api/v2/stock/${encodeURIComponent(code)}/detail`,
    { headers: hankyungHeaders(), timeout: 2500 },
    2500
  );
  sendJson(res, 200, data);
}

async function getKoreaStockQuote(res, code) {
  if (!/^\d{6}$/.test(String(code || ""))) {
    sendJson(res, 400, { error: "잘못된 종목 코드입니다." });
    return;
  }

  const quotes = await fetchNaverKoreaStocksByCodes([code]);
  const stock = quotes.get(code);
  if (!stock?.close) {
    sendJson(res, 404, { error: "종목 시세를 찾지 못했습니다." });
    return;
  }
  sendJson(res, 200, { source: "Naver", stock });
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

function normalizeNaverRealtimeStock(realtime = {}) {
  const close = parsePlainNumber(realtime.closePrice);
  const volume = parsePlainNumber(realtime.accumulatedTradingVolume);
  const tradingValue = parseKoreanMoneyToEok(realtime.accumulatedTradingValue) ?? tradingValueEok(close, volume);
  return {
    shcode: realtime.itemCode || "",
    name: realtime.stockName || "",
    chgrate: parsePlainNumber(realtime.fluctuationsRatio),
    chgprc: parsePlainNumber(realtime.compareToPreviousClosePrice),
    date: realtime.localTradedAt || "",
    volume,
    tradingValue,
    close,
    open: parsePlainNumber(realtime.openPrice),
    high: parsePlainNumber(realtime.highPrice),
    low: parsePlainNumber(realtime.lowPrice),
  };
}

async function fetchNaverKoreaStocksByCodes(codes) {
  const uniqueCodes = Array.from(new Set(codes.filter((code) => /^\d{6}$/.test(String(code || "")))));
  if (!uniqueCodes.length) return new Map();

  const batches = [];
  for (let index = 0; index < uniqueCodes.length; index += 80) {
    batches.push(uniqueCodes.slice(index, index + 80));
  }

  const results = await Promise.allSettled(
    batches.map((batch) =>
      fetchJson(
        `https://polling.finance.naver.com/api/realtime/domestic/stock/${batch.join(",")}`,
        {
          headers: {
            Accept: "application/json, text/plain, */*",
            Referer: "https://m.stock.naver.com/",
          },
          timeout: 1600,
        },
        2500
      )
    )
  );

  const byCode = new Map();
  results.forEach((result) => {
    if (result.status !== "fulfilled") return;
    (result.value?.datas || []).forEach((stock) => {
      const normalized = normalizeNaverRealtimeStock(stock);
      if (normalized.shcode) byCode.set(normalized.shcode, normalized);
    });
  });
  return byCode;
}

function applyRealtimeToKoreaMap(map, realtimeByCode, { preserveRate = false } = {}) {
  if (!realtimeByCode?.size) return map;
  map.children?.forEach((group) => {
    group.children?.forEach((stock) => {
      const realtime = realtimeByCode.get(stock.shcode);
      if (!realtime) return;
      const previous = realtime.close != null && realtime.chgprc != null ? realtime.close - realtime.chgprc : stock.previous;
      const rate = preserveRate ? stock.chgrate : realtime.chgrate ?? stock.chgrate;
      Object.assign(stock, {
        close: realtime.close ?? stock.close,
        chgrate: rate,
        chgprc: preserveRate ? stock.chgprc : realtime.chgprc ?? stock.chgprc,
        date: realtime.date || stock.date,
        volume: realtime.volume ?? stock.volume,
        tradingValue: realtime.tradingValue ?? stock.tradingValue,
        previous,
        open: realtime.open ?? stock.open,
        high: realtime.high ?? stock.high,
        low: realtime.low ?? stock.low,
        fill: preserveRate ? stock.fill : hankyungHeatColor(rate),
      });
    });
  });
  map.realtimeSource = "Naver";
  return map;
}

async function enrichKoreaMapWithRealtime(map, options = {}) {
  const limit = options.limit ?? 2000;
  const stocks = (map.children || [])
    .flatMap((group) => group.children || [])
    .filter((stock) => stock?.shcode)
    .sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
  const codes = stocks.slice(0, limit).map((stock) => stock.shcode);
  const realtimeByCode = await fetchNaverKoreaStocksByCodes(codes);
  applyRealtimeToKoreaMap(map, realtimeByCode, options);

  const missingCodeStocks = (map.children || [])
    .flatMap((group) => group.children || [])
    .filter((stock) => !stock.shcode && stock.name)
    .slice(0, 20);
  if (missingCodeStocks.length) {
    const results = await Promise.allSettled(
      missingCodeStocks.map((stock) => fetchNaverKoreaStockByName(stock.name))
    );
    results.forEach((result, index) => {
      if (result.status !== "fulfilled" || !result.value?.shcode) return;
      const stock = missingCodeStocks[index];
      const rate = options.preserveRate ? stock.chgrate : result.value.chgrate ?? stock.chgrate;
      Object.assign(stock, {
        ...result.value,
        value: stock.value || result.value.value,
        chgrate: rate,
        fill: options.preserveRate ? stock.fill : hankyungHeatColor(rate),
      });
    });
  }

  return map;
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
  const item = items.find((entry) =>
    /^\d{6}$/.test(String(entry.code || "")) &&
    (normalizeKoreaStockName(entry.name) === normalizeKoreaStockName(name) || /코스피|코스닥/i.test(entry.typeName || ""))
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
  const normalized = normalizeNaverRealtimeStock(realtime);

  return {
    shcode: item.code,
    name: integration.stockName || normalized.name || item.name || name,
    value: marketCap,
    chgrate: normalized.chgrate,
    chgprc: normalized.chgprc,
    date: normalized.date,
    volume: normalized.volume,
    tradingValue: normalized.tradingValue,
    close: normalized.close,
    previous: parsePlainNumber(naverInfoValue(integration, "lastClosePrice")),
    open: normalized.open ?? parsePlainNumber(naverInfoValue(integration, "openPrice")),
    high: normalized.high ?? parsePlainNumber(naverInfoValue(integration, "highPrice")),
    low: normalized.low ?? parsePlainNumber(naverInfoValue(integration, "lowPrice")),
  };
}

async function getKoreaStockByName(res, name) {
  const target = String(name || "").trim();
  if (!target || target.length > 40) {
    sendJson(res, 400, { error: "잘못된 종목명입니다." });
    return;
  }

  try {
    const naverStock = await fetchNaverKoreaStockByName(target);
    if (naverStock?.close != null) {
      sendJson(res, 200, { source: "Naver", stock: naverStock });
      return;
    }
  } catch (error) {
    // Fall back to Hankyung if Naver is temporarily slow or unavailable.
  }

  const lookup = await getHankyungStockLookup();
  const matched = lookup.get(target) ||
    lookup.get(normalizeKoreaStockName(target)) ||
    Array.from(lookup.values()).find((stock) => normalizeKoreaStockName(stock.shname || stock.name) === normalizeKoreaStockName(target));

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
        { headers: hankyungHeaders(matched.sourceMarket || "KOSPI"), timeout: 2500 },
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

async function fetchTradingViewUsMap() {
  const columns = ["name", "description", "sector", "close", "change", "change_abs", "volume", "market_cap_basic"];
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
        options: { lang: "en" },
        symbols: { query: { types: ["stock"] }, tickers: [] },
        columns,
        sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
        range: [0, 900],
      }),
      timeout: 16000,
    },
    15000
  );

  const groups = new Map();
  (data.data || []).forEach((row) => {
    const values = row.d || [];
    const ticker = String(row.s || "").split(":").pop()?.replace("-", ".") || values[0];
    const exchange = String(row.s || "").split(":")[0] || "";
    const sectorName = values[2] || "Other";
    const description = values[1] || values[0] || ticker;
    if (!["NASDAQ", "NYSE", "AMEX"].includes(exchange)) return;
    if (/[/$]/.test(ticker)) return;
    if (/preferred|depositary|warrant|right|unit|note|bond|debenture/i.test(description)) return;
    const close = formatNumber(values[3]);
    const rate = formatNumber(values[4]);
    const change = formatNumber(values[5]);
    const volume = formatNumber(values[6]);
    const marketCap = formatNumber(values[7]);
    if (!ticker || marketCap == null || close == null) return;

    const group = groups.get(sectorName) || {
      name: sectorName,
      upcode: sectorName,
      type: "industry",
      children: [],
    };
    group.children.push({
      shcode: ticker,
      symbol: ticker,
      name: description,
      shortName: values[0] || ticker,
      exchange,
      value: marketCap,
      marketCap,
      chgrate: rate || 0,
      chgprc: change,
      date: "",
      volume,
      tradingValue: tradingValueUsd(close, volume),
      close,
      previous: close != null && change != null ? close - change : null,
      sourceMarket: "US",
      fill: kospdHeatColor(rate),
      type: "stock",
    });
    groups.set(sectorName, group);
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
    name: "US Stock Heat Map",
    header: "1day",
    id: "US-STOCKS-1DAY",
    symbol: "US",
    source: "TradingView",
    children,
    updatedAt: new Date().toISOString(),
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
      timeout: 2500,
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

async function getUsMap(res) {
  sendJson(res, 200, await fetchTradingViewUsMap());
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

    if (url.pathname.startsWith("/api/korea-stock-quote/")) {
      await getKoreaStockQuote(res, decodeURIComponent(url.pathname.split("/").pop()));
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

    if (url.pathname === "/api/us-map") {
      await getUsMap(res);
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
