const state = {
  koreaMap: null,
  koreaMarket: "KOSPI",
  koreaTerm: "1day",
  koreaSector: "",
  timers: [],
  finalKoreaRefreshKey: "",
};

const KOSPD_TERMS = {
  "1day": "1일",
  "1week": "일주일",
  "1month": "한 달",
  "3months": "세 달",
  "6months": "여섯 달",
  "1year": "일 년",
  ytd: "연초",
};

const elements = {
  kospiIndex: document.getElementById("kospiIndex"),
  kosdaqIndex: document.getElementById("kosdaqIndex"),
  usdKrwIndex: document.getElementById("usdKrwIndex"),
  nasdaqIndex: document.getElementById("nasdaqIndex"),
  topSp500Index: document.getElementById("topSp500Index"),
  refreshLabel: document.getElementById("refreshLabel"),
  koreaTitle: document.getElementById("koreaTitle"),
  koreaSubtitle: document.getElementById("koreaSubtitle"),
  koreaMap: document.getElementById("koreaMap"),
  koreaLoading: document.getElementById("koreaLoading"),
  usMap: document.getElementById("usMap"),
  refreshKorea: document.getElementById("refreshKorea"),
  refreshUs: document.getElementById("refreshUs"),
  sectorBack: document.getElementById("sectorBack"),
  marketSegments: document.querySelectorAll("[data-market]"),
  termSegments: document.querySelectorAll("[data-term]"),
  modalBackdrop: document.getElementById("modalBackdrop"),
  modalBody: document.getElementById("modalBody"),
  modalClose: document.getElementById("modalClose"),
};

const nf = new Intl.NumberFormat("ko-KR");
const priceFormat = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 2,
});

function number(value, digits = 2) {
  if (value == null || value === "") return "--";
  const num = Number(value);
  if (!Number.isFinite(num)) return "--";
  return num.toLocaleString("ko-KR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function compact(value) {
  if (value == null || value === "") return "--";
  const num = Number(value);
  if (!Number.isFinite(num)) return "--";
  return nf.format(Math.round(num));
}

function compactWon(value) {
  if (value == null || value === "") return "--";
  const num = Number(value);
  if (!Number.isFinite(num)) return "--";
  if (num >= 10000) return `${number(num / 10000, 1)}조원`;
  return `${compact(num)}억원`;
}

function signed(value, digits = 2) {
  if (value == null || value === "") return "--";
  const num = Number(value);
  if (!Number.isFinite(num)) return "--";
  const sign = num > 0 ? "+" : "";
  return `${sign}${number(num, digits)}`;
}

function directionClass(value) {
  if (value == null || value === "") return "neutral";
  const num = Number(value);
  if (num > 0) return "positive";
  if (num < 0) return "negative";
  return "neutral";
}

async function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("GET", `${url}${url.includes("?") ? "&" : "?"}ts=${Date.now()}`, true);
    request.responseType = "json";
    request.timeout = 15000;
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve(request.response || JSON.parse(request.responseText));
        return;
      }
      reject(new Error(request.responseText || request.statusText));
    };
    request.onerror = () => reject(new Error("네트워크 요청이 실패했습니다."));
    request.ontimeout = () => reject(new Error("네트워크 요청 시간이 초과되었습니다."));
    request.send();
  });
}

function setIndex(el, index = {}) {
  if (!el) return;
  const close = el.querySelector("strong");
  const change = el.querySelector(".index-change");
  close.textContent = index.available ? number(index.close, 2) : "--";
  close.className = index.available ? directionClass(index.change) : "neutral";
  change.textContent = index.available
    ? `${signed(index.change, 2)} (${signed(index.changeRate, 2)}%)`
    : "데이터 없음";
  change.className = `index-change ${directionClass(index.change)}`;
}

async function refreshIndices() {
  try {
    const data = await getJson("/api/indices");
    const kospi = data.kospi || {};
    const kosdaq = data.kosdaq || {};
    const usdkrw = data.usdkrw || {};
    const nasdaq = data.nasdaq || {};
    const sp500 = data.sp500 || {};

    setIndex(elements.kospiIndex, kospi);
    setIndex(elements.kosdaqIndex, kosdaq);
    setIndex(elements.usdKrwIndex, usdkrw);
    setIndex(elements.nasdaqIndex, nasdaq);
    setIndex(elements.topSp500Index, sp500);

    document.title = `KOSPI ${number(kospi.close, 2)} (${signed(kospi.changeRate, 2)}%, ${signed(kospi.change, 2)}) | KOSDAQ ${number(kosdaq.close, 2)} (${signed(kosdaq.changeRate, 2)}%, ${signed(kosdaq.change, 2)}) | Nasdaq ${number(nasdaq.close, 2)} (${signed(nasdaq.changeRate, 2)}%, ${signed(nasdaq.change, 2)}) | S&P500 ${number(sp500.close, 2)} (${signed(sp500.changeRate, 2)}%, ${signed(sp500.change, 2)})`;
  } catch (error) {
    elements.refreshLabel.textContent = "지수 데이터를 불러오지 못했습니다. 새로고침을 눌러 다시 시도하세요.";
  }
}

function worst(row, side) {
  if (!row.length) return Infinity;
  const areas = row.map((item) => item.area);
  const sum = areas.reduce((acc, value) => acc + value, 0);
  const max = Math.max(...areas);
  const min = Math.min(...areas);
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}

function layoutRow(row, rect, horizontal) {
  const total = row.reduce((acc, item) => acc + item.area, 0);
  const layouts = [];

  if (horizontal) {
    const height = total / rect.w;
    let x = rect.x;
    row.forEach((item) => {
      const width = item.area / height;
      layouts.push({ item: item.source, x, y: rect.y, w: width, h: height });
      x += width;
    });
    return { layouts, rest: { x: rect.x, y: rect.y + height, w: rect.w, h: rect.h - height } };
  }

  const width = total / rect.h;
  let y = rect.y;
  row.forEach((item) => {
    const height = item.area / width;
    layouts.push({ item: item.source, x: rect.x, y, w: width, h: height });
    y += height;
  });
  return { layouts, rest: { x: rect.x + width, y: rect.y, w: rect.w - width, h: rect.h } };
}

function squarify(items, rect) {
  const areaValue = (item) => Math.max(Number(item.areaValue ?? item.value) || 0, 0);
  const totalValue = items.reduce((sum, item) => sum + areaValue(item), 0);
  if (!totalValue || rect.w <= 0 || rect.h <= 0) return [];

  const scale = (rect.w * rect.h) / totalValue;
  const queue = items
    .filter((item) => areaValue(item) > 0)
    .sort((a, b) => areaValue(b) - areaValue(a))
    .map((item) => ({ source: item, area: areaValue(item) * scale }));

  let remaining = { ...rect };
  let row = [];
  const layouts = [];

  while (queue.length) {
    const next = queue[0];
    const side = Math.min(remaining.w, remaining.h);
    if (!row.length || worst([...row, next], side) <= worst(row, side)) {
      row.push(queue.shift());
      continue;
    }

    const result = layoutRow(row, remaining, remaining.w < remaining.h);
    layouts.push(...result.layouts);
    remaining = result.rest;
    row = [];
  }

  if (row.length) {
    const result = layoutRow(row, remaining, remaining.w < remaining.h);
    layouts.push(...result.layouts);
  }

  return layouts;
}

function tileFontVisible(layout, scale) {
  const area = layout.w * layout.h;
  return layout.w > 30 && layout.h > 18 && area > 560 && scale > 0.018;
}

function flattenKoreaStocks(data) {
  const stocks = new Map();
  (data.children || []).forEach((sector) => {
    (sector.children || []).forEach((stock) => {
      stocks.set(stockKey(stock), stock);
    });
  });
  return stocks;
}

function stockKey(stock) {
  return stock.shcode || stock.name || "";
}

function findKoreaStock(key) {
  if (!state.koreaMap) return null;
  return flattenKoreaStocks(state.koreaMap).get(key) || null;
}

function koreaSubtitle(market) {
  if (market === "KRX300") return `KOSPD KRX 300 ${KOSPD_TERMS[state.koreaTerm] || "1일"} 맵`;
  if (state.koreaTerm === "1day") return `한국경제 ${market} 1일 맵`;
  return `KOSPD ${market} ${KOSPD_TERMS[state.koreaTerm] || "1일"} 맵`;
}

function getVisibleSectors(data) {
  const sectors = data.children || [];
  if (!state.koreaSector) return sectors;
  return sectors.filter((sector) => sector.name === state.koreaSector);
}

function updateKoreaHeader() {
  elements.koreaTitle.textContent = state.koreaSector
    ? `${state.koreaMarket} / ${state.koreaSector}`
    : state.koreaMarket;
  elements.koreaSubtitle.textContent = koreaSubtitle(state.koreaMarket);
  elements.koreaMap.setAttribute("aria-label", `${state.koreaMarket} 종목 마켓맵`);
  elements.koreaLoading.textContent = `${state.koreaMarket} 맵을 불러오는 중`;
  elements.sectorBack.hidden = !state.koreaSector;
}

function renderKoreaMap(data) {
  state.koreaMap = data;
  state.koreaMarket = data.symbol || state.koreaMarket;
  const host = elements.koreaMap;
  host.innerHTML = "";
  hideTooltip();
  updateKoreaHeader();

  const width = host.clientWidth;
  const height = host.clientHeight;
  const sectors = getVisibleSectors(data);
  const maxStockValue = Math.max(
    1,
    ...sectors.flatMap((sector) => (sector.children || []).map((stock) => Number(stock.value) || 0))
  );
  const sectorItems = sectors.map((sector) => ({
    ...sector,
    value: (sector.children || []).reduce((sum, stock) => sum + (Number(stock.value) || 0), 0),
    children: (sector.children || []).map((stock) => ({
      ...stock,
    })),
  }));

  squarify(sectorItems, { x: 0, y: 0, w: width, h: height }).forEach((sectorLayout) => {
    const sector = sectorLayout.item;
    const sectorEl = document.createElement("div");
    sectorEl.className = "sector";
    sectorEl.style.left = `${sectorLayout.x}px`;
    sectorEl.style.top = `${sectorLayout.y}px`;
    sectorEl.style.width = `${sectorLayout.w}px`;
    sectorEl.style.height = `${sectorLayout.h}px`;

    const label = document.createElement("button");
    label.type = "button";
    label.className = "sector-label";
    label.textContent = state.koreaSector ? `${sector.name} 전체` : sector.name;
    label.title = state.koreaSector ? "전체 맵으로 돌아가기" : `${sector.name} 섹션으로 들어가기`;
    label.addEventListener("click", (event) => {
      event.stopPropagation();
      if (state.koreaSector) {
        clearKoreaSector();
      } else {
        setKoreaSector(sector.name);
      }
    });
    sectorEl.append(label);

    const pad = 4;
    const header = sectorLayout.h > 44 ? 24 : 0;
    const inner = {
      x: pad,
      y: header,
      w: Math.max(0, sectorLayout.w - pad * 2),
      h: Math.max(0, sectorLayout.h - header - pad),
    };

    squarify(sector.children || [], inner).forEach((stockLayout) => {
      const stock = stockLayout.item;

      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "tile";
      tile.dataset.key = stockKey(stock);
      tile.style.left = `${stockLayout.x}px`;
      tile.style.top = `${stockLayout.y}px`;
      tile.style.width = `${stockLayout.w}px`;
      tile.style.height = `${stockLayout.h}px`;
      tile.style.background = stock.fill || (stock.chgrate >= 0 ? "#bd3945" : "#4162c4");
      tile.title = `${stock.name} ${signed(stock.chgrate, 2)}%`;
      const valueScale = Math.max(0, Math.min(1, Math.sqrt((Number(stock.value) || 0) / maxStockValue)));
      const areaScale = Math.max(0, Math.min(1, (stockLayout.w * stockLayout.h) / 80000));
      const labelScale = Math.max(valueScale, Math.sqrt(areaScale) * 0.72);
      const nameFont = Math.round(8 + labelScale * 30);
      const rateFont = Math.round(7 + labelScale * 15);
      tile.style.setProperty("--tile-font", `${nameFont}px`);
      tile.style.setProperty("--tile-rate-font", `${rateFont}px`);
      tile.addEventListener("click", () => openKoreaStockFromTile(findKoreaStock(tile.dataset.key) || stock));
      tile.addEventListener("mouseenter", (event) => showKoreaTooltip(event, findKoreaStock(tile.dataset.key) || stock));
      tile.addEventListener("mousemove", (event) => moveTooltip(event));
      tile.addEventListener("mouseleave", hideTooltip);

      if (tileFontVisible(stockLayout, labelScale)) {
        const name = document.createElement("span");
        name.className = "tile-name";
        name.textContent = stock.name;
        tile.append(name);
        if (stockLayout.w * stockLayout.h > 1050 && stockLayout.h > 30) {
          const rate = document.createElement("span");
          rate.className = "tile-rate";
          rate.textContent = `${signed(stock.chgrate, 2)}%`;
          tile.append(rate);
        }
      }

      sectorEl.append(tile);
    });

    host.append(sectorEl);
  });
}

function updateKoreaMapData(data) {
  state.koreaMap = data;
  const stocks = flattenKoreaStocks(data);

  elements.koreaMap.querySelectorAll(".tile").forEach((tile) => {
    const stock = stocks.get(tile.dataset.key);
    if (!stock) return;

    tile.style.background = stock.fill || (stock.chgrate >= 0 ? "#bd3945" : "#4162c4");
    tile.title = `${stock.name} ${signed(stock.chgrate, 2)}%`;
    const rate = tile.querySelector(".tile-rate");
    if (rate) rate.textContent = `${signed(stock.chgrate, 2)}%`;
  });
}

async function refreshKoreaMap({ forceRender = false, showLoading = false } = {}) {
  if (showLoading) elements.koreaLoading.hidden = false;
  try {
    const data = await getJson(
      `/api/korea-map?market=${encodeURIComponent(state.koreaMarket)}&term=${encodeURIComponent(state.koreaTerm)}`
    );
    if (forceRender || !state.koreaMap || !elements.koreaMap.querySelector(".tile")) {
      renderKoreaMap(data);
    } else {
      updateKoreaMapData(data);
    }
    elements.koreaLoading.hidden = true;
  } catch (error) {
    elements.koreaLoading.hidden = false;
    elements.koreaLoading.innerHTML = `
      <div class="load-error">
        <strong>한국 히트맵을 불러오지 못했습니다.</strong>
        <button type="button" id="retryKoreaMap">다시 불러오기</button>
      </div>
    `;
    document.getElementById("retryKoreaMap")?.addEventListener("click", () => {
      elements.koreaLoading.textContent = `${state.koreaMarket} 맵을 불러오는 중`;
      refreshKoreaMap({ forceRender: true, showLoading: true });
    });
  }
}

function setKoreaMarket(market) {
  state.koreaMarket = market === "KOSDAQ" ? "KOSDAQ" : market === "KOSPI" ? "KOSPI" : "KRX300";
  state.koreaSector = "";
  updateKoreaHeader();
  elements.marketSegments.forEach((button) => {
    button.classList.toggle("active", button.dataset.market === state.koreaMarket);
  });
  state.koreaMap = null;
  refreshKoreaMap({ forceRender: true, showLoading: true });
}

function setKoreaTerm(term) {
  state.koreaTerm = KOSPD_TERMS[term] ? term : "1day";
  state.koreaSector = "";
  updateKoreaHeader();
  elements.termSegments.forEach((button) => {
    button.classList.toggle("active", button.dataset.term === state.koreaTerm);
  });
  state.koreaMap = null;
  refreshKoreaMap({ forceRender: true, showLoading: true });
}

function setKoreaSector(sectorName) {
  state.koreaSector = sectorName;
  renderKoreaMap(state.koreaMap);
}

function clearKoreaSector() {
  state.koreaSector = "";
  renderKoreaMap(state.koreaMap);
}

function ensureTooltip() {
  let tooltip = document.getElementById("hoverTooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "hoverTooltip";
    tooltip.className = "hover-tooltip";
    tooltip.hidden = true;
    document.body.append(tooltip);
  }
  return tooltip;
}

function showKoreaTooltip(event, stock) {
  const tooltip = ensureTooltip();
  tooltip.innerHTML = `
    <div class="tooltip-title">
      <strong>${stock.name || "--"}</strong>
      <span>${stock.shcode || ""}</span>
    </div>
    <div class="tooltip-sub">${state.koreaMarket} · ${stock.date || ""}</div>
    <div class="tooltip-price">
      <strong>${compact(stock.close)}</strong>
      <span class="${directionClass(stock.chgrate)}">${signed(stock.chgrate, 2)}%</span>
    </div>
    <div class="tooltip-grid">
      <div class="tooltip-row"><span>시가총액</span><strong>${compactWon(stock.value)}</strong></div>
      <div class="tooltip-row"><span>거래량</span><strong>${compact(stock.volume)}</strong></div>
    </div>
  `;
  tooltip.hidden = false;
  moveTooltip(event);
}

function moveTooltip(event) {
  const tooltip = ensureTooltip();
  if (tooltip.hidden) return;
  const pad = 14;
  const rect = tooltip.getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = event.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = event.clientY - rect.height - pad;
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${Math.max(8, y)}px`;
}

function hideTooltip() {
  const tooltip = document.getElementById("hoverTooltip");
  if (tooltip) tooltip.hidden = true;
}

function reloadUsMap() {
  elements.usMap.src = `/finviz-map?ts=${Date.now()}`;
}

function isMarketOpen(zone, openHour, openMinute, closeHour, closeMinute) {
  return getMarketClock(zone).isWeekday && isClockBetween(getMarketClock(zone).minutes, openHour, openMinute, closeHour, closeMinute);
}

function getMarketClock(zone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const weekday = get("weekday");
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  return {
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
    isWeekday: weekday !== "Sat" && weekday !== "Sun",
    minutes: hour * 60 + minute,
  };
}

function isClockBetween(current, openHour, openMinute, closeHour, closeMinute) {
  return current >= openHour * 60 + openMinute && current <= closeHour * 60 + closeMinute;
}

function updateRefreshMode() {
  const koreaOpen = isMarketOpen("Asia/Seoul", 9, 0, 15, 30);
  const usOpen = isMarketOpen("America/New_York", 9, 30, 16, 0);
  const active = koreaOpen || usOpen;
  elements.refreshLabel.textContent = active
    ? "개장 중: 3초마다 자동 새로고침"
    : "장 종료: 수동 새로고침";
  return active;
}

function resetTimers() {
  state.timers.forEach(clearInterval);
  state.timers = [];

  if (updateRefreshMode()) {
    state.timers.push(setInterval(refreshAll, 3000));
  }
  checkKoreaFinalRefresh();
  state.timers.push(setInterval(resetTimers, 60000));
  state.timers.push(setInterval(checkKoreaFinalRefresh, 30000));
}

async function refreshAll() {
  await Promise.allSettled([refreshIndices(), refreshKoreaMap()]);
}

function checkKoreaFinalRefresh() {
  const koreaClock = getMarketClock("Asia/Seoul");
  const finalMinute = 15 * 60 + 35;
  if (!koreaClock.isWeekday || koreaClock.minutes < finalMinute) return;
  if (state.finalKoreaRefreshKey === koreaClock.dateKey) return;

  state.finalKoreaRefreshKey = koreaClock.dateKey;
  refreshAll();
}

function showModal(html) {
  elements.modalBody.innerHTML = html;
  elements.modalBackdrop.hidden = false;
}

function hideModal() {
  elements.modalBackdrop.hidden = true;
  elements.modalBody.innerHTML = "";
}

function stat(label, value) {
  return `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`;
}

function firstPresent(...values) {
  return values.find((value) => value != null && value !== "" && Number.isFinite(Number(value)));
}

function openKoreaStockFromTile(stock) {
  const kospdUrl = `https://www.kospd.com/maps/${state.koreaTerm}`;
  if (stock.shcode) {
    openKoreaStock(stock.shcode, stock);
    return;
  }

  showModal(`
    <div class="stock-popup">
      <h3 id="modalTitle">${stock.name}</h3>
      <p class="sub">${state.koreaMarket} · ${KOSPD_TERMS[state.koreaTerm] || "1일"} 맵</p>
      <div class="price-line">
        <strong>${compact(stock.close)}</strong>
        <span class="${directionClass(stock.chgrate)}">${signed(stock.chgrate, 2)}%</span>
      </div>
      <div class="stat-grid">
        ${stat("시가총액", compactWon(stock.value))}
        ${stat("거래량", compact(stock.volume))}
      </div>
      <a class="link-button" href="${kospdUrl}" target="_blank" rel="noreferrer">KOSPD에서 보기</a>
    </div>
  `);
}

async function openKoreaStock(code, fallback) {
  showModal(`<div class="stock-popup"><h3 id="modalTitle">${fallback.name}</h3><p class="sub">불러오는 중</p></div>`);
  try {
    const data = await getJson(`/api/korea-stock/${encodeURIComponent(code)}`);
    const stock = data.stock || {};
    const trader = stock.stock_trader || {};
    const consensus = data.consensus?.latest;
    const displayPrice = firstPresent(trader.curprc, stock.close_1dy, fallback.close);
    const displayChange = firstPresent(trader.chgprc, fallback.chgprc);
    const displayRate = firstPresent(trader.chgrate, fallback.chgrate);

    showModal(`
      <div class="stock-popup">
        <h3 id="modalTitle">${stock.shname || fallback.name}</h3>
        <p class="sub">${stock.shcode || code} · ${stock.ename || "KOSPI"}</p>
        <div class="price-line">
          <strong>${displayPrice == null ? "--" : priceFormat.format(Number(displayPrice))}</strong>
          <span class="${directionClass(displayChange)}">${signed(displayChange, 0)} (${signed(displayRate, 2)}%)</span>
        </div>
        <div class="stat-grid">
          ${stat("시가", compact(trader.openprc))}
          ${stat("고가", compact(trader.highprc))}
          ${stat("저가", compact(trader.lowprc))}
          ${stat("거래량", compact(trader.volume || fallback.volume))}
          ${stat("PER", stock.per || "--")}
          ${stat("PBR", stock.pbr || "--")}
          ${stat("시가총액", stock.mkt_cap ? `${compact(stock.mkt_cap)} 억원` : "--")}
          ${stat("컨센서스", consensus ? `${consensus.opinion_mark_name || consensus.OPINION} / ${compact(consensus.MEAN)}` : "--")}
        </div>
        <a class="link-button" href="https://markets.hankyung.com/stock/${stock.shcode || code}" target="_blank" rel="noreferrer">한국경제에서 보기</a>
        ${state.koreaMarket === "KRX300" ? `<a class="link-button secondary" href="https://www.kospd.com/maps/${state.koreaTerm}" target="_blank" rel="noreferrer">KOSPD 맵에서 보기</a>` : ""}
      </div>
    `);
  } catch (error) {
    showModal(`<div class="stock-popup"><h3 id="modalTitle">${fallback.name}</h3><p class="sub">종목 정보를 불러오지 못했습니다.</p></div>`);
  }
}

async function openUsStock(ticker) {
  showModal(`<div class="stock-popup"><h3 id="modalTitle">${ticker}</h3><p class="sub">불러오는 중</p></div>`);
  try {
    const data = await getJson(`/api/us-stock/${encodeURIComponent(ticker)}`);
    const quote = data.quote || {};
    showModal(`
      <div class="stock-popup">
        <h3 id="modalTitle">${data.ticker}</h3>
        <p class="sub">${data.ticker} · US stock · ${quote.date || "Stooq"}</p>
        <div class="price-line">
          <strong>${number(quote.close, 2)}</strong>
          <span class="${directionClass(quote.change)}">${signed(quote.change, 2)} (${signed(quote.changeRate, 2)}%)</span>
        </div>
        <div class="stat-grid">
          ${stat("시가", number(quote.open, 2))}
          ${stat("고가", number(quote.high, 2))}
          ${stat("저가", number(quote.low, 2))}
          ${stat("거래량", compact(quote.volume))}
          ${stat("전일 종가", number(quote.previous, 2))}
          ${stat("데이터", quote.available ? "정상" : "없음")}
        </div>
        <a class="link-button" href="${data.finvizUrl}" target="_blank" rel="noreferrer">Finviz에서 보기</a>
      </div>
    `);
  } catch (error) {
    showModal(`<div class="stock-popup"><h3 id="modalTitle">${ticker}</h3><p class="sub">종목 정보를 불러오지 못했습니다.</p></div>`);
  }
}

elements.refreshKorea.addEventListener("click", () => {
  refreshIndices();
  refreshKoreaMap({ forceRender: true, showLoading: true });
});
elements.sectorBack.addEventListener("click", clearKoreaSector);
elements.refreshUs.addEventListener("click", () => {
  refreshIndices();
  reloadUsMap();
});
elements.modalClose.addEventListener("click", hideModal);
elements.modalBackdrop.addEventListener("click", (event) => {
  if (event.target === elements.modalBackdrop) hideModal();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideModal();
});
window.addEventListener("resize", () => {
  if (state.koreaMap) renderKoreaMap(state.koreaMap);
});
window.addEventListener("message", (event) => {
  if (event.data?.type === "stock-click" && event.data.market === "US") {
    openUsStock(event.data.symbol);
  }
  if (event.data?.type === "iframe-wheel") {
    window.scrollBy({ top: event.data.deltaY, left: 0, behavior: "auto" });
  }
});
elements.marketSegments.forEach((button) => {
  button.addEventListener("click", () => setKoreaMarket(button.dataset.market));
});
elements.termSegments.forEach((button) => {
  button.addEventListener("click", () => setKoreaTerm(button.dataset.term));
});

refreshAll();
resetTimers();
