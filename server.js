const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const HANKYUNG_API_KEY =
  "0ZdNlr7LrQoawewqweq78k6usasBsqhqSIaUarSTf8mxnHuQVh9CvKAfpUy94LhBmZMg";
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
  const cached = cache.get(url);
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
      cache.set(url, { text, time: Date.now() });
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

    group.children.push({
      shcode: stock.shcode,
      name: stock.shname,
      value: marketCap || 0,
      chgrate: rate || 0,
      chgprc: change,
      date: trader.workdate || stock.workdate,
      volume: trader.volume || stock.prevol,
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
  return market === "KOSDAQ" ? "KOSDAQ" : "KOSPI";
}

async function getKoreaMap(res, market) {
  const symbol = parseKoreaMarket(market);
  const upcode = symbol === "KOSDAQ" ? "2001" : "1001";
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

  sendJson(res, 200, normalizeKoreaMap(symbol, industries, stocks));
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
    available: true,
  };
}

async function getIndices(res) {
  const [summary, nasdaqCsv, usdKrwCsv] = await Promise.all([
    fetchJson("https://markets.hankyung.com/api/v2/main/summary-indices", {
      headers: hankyungHeaders(),
    }, 2500),
    fetchText("https://stooq.com/q/l/?s=%5Endq&f=sd2t2ohlcvp&e=csv", {}, 2500),
    fetchText("https://stooq.com/q/l/?s=usdkrw&f=sd2t2ohlcvp&e=csv", {}, 2500),
  ]);

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
    usdkrw: {
      name: "USD/KRW",
      ...parseStooqQuote(usdKrwCsv, "USDKRW"),
    },
    nasdaq: {
      name: "Nasdaq",
      ...parseStooqQuote(nasdaqCsv, "^NDQ"),
    },
    updatedAt: new Date().toISOString(),
  });
}

async function getUsStock(res, ticker) {
  const symbol = ticker.toUpperCase().replace(/[^A-Z.-]/g, "");
  if (!symbol || symbol.length > 12) {
    sendJson(res, 400, { error: "잘못된 티커입니다." });
    return;
  }

  const stooqSymbol = `${symbol.toLowerCase().replace(".", "-")}.us`;
  const csv = await fetchText(
    `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSymbol)}&f=sd2t2ohlcvp&e=csv`,
    {},
    2500
  );
  sendJson(res, 200, {
    ticker: symbol,
    source: "Stooq",
    quote: parseStooqQuote(csv, symbol),
    finvizUrl: `https://finviz.com/quote.ashx?t=${encodeURIComponent(symbol)}&p=d`,
  });
}

async function getFinvizMap(res) {
  let html = await fetchText("https://finviz.com/map?t=sec&st=d1", {}, 2500);
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
    var match = String(value || "").match(/(?:[?&]t=|^)([A-Z]{1,6}(?:[.-][A-Z])?)(?:$|[&\\s:])/);
    return match ? match[1].replace("-", ".") : "";
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
    var ticker = pickTicker(event.target);
    if (!ticker) return;
    event.preventDefault();
    event.stopPropagation();
    sendTicker(ticker);
  }, true);

  document.addEventListener("dblclick", function (event) {
    var ticker = pickTicker(event.target);
    if (!ticker) return;
    event.preventDefault();
    event.stopPropagation();
    sendTicker(ticker);
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
    "Content-Security-Policy": "",
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
      await getKoreaMap(res, url.searchParams.get("market"));
      return;
    }

    if (url.pathname.startsWith("/api/korea-stock/")) {
      await getKoreaStock(res, decodeURIComponent(url.pathname.split("/").pop()));
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
