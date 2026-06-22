/* =========================================================================
 * GP Printer - OSRS Grand Exchange flipping calculator
 * app.js  ·  vanilla ES2020, no build step, no dependencies
 * -------------------------------------------------------------------------
 * Data flow:
 *   1. Pull item metadata (mapping), latest prices, and 1h/24h volume
 *      from the OSRS Wiki real-time prices API.
 *   2. Join into a single dataset and compute per-item flip economics
 *      (margin after GE tax, ROI, liquidity, freshness, volatility).
 *   3. Filter + score the dataset for the chosen flipping style.
 *   4. Greedily allocate the player's coin stack into a concrete plan
 *      respecting GE buy limits - "buy X of Y at Z, sell at W".
 * ========================================================================= */
'use strict';

(() => {
  /* ===================================================================== *
   *  CONFIG & CONSTANTS
   * ===================================================================== */
  const API = 'https://prices.runescape.wiki/api/v1/osrs';
  const GE_SPRITE = 'https://secure.runescape.com/m=itemdb_oldschool/obj_sprite.gif?id=';
  const WIKI_FILE = 'https://oldschool.runescape.wiki/w/Special:FilePath/';

  /** Point an <img> at the official GE sprite, falling back to the wiki file. */
  function setItemIcon(img, item) {
    img.src = GE_SPRITE + item.id;
    img.onerror = function () {
      this.onerror = null;
      this.src = WIKI_FILE + encodeURIComponent((item.icon || '').replace(/ /g, '_'));
    };
  }

  // Grand Exchange sales tax: 2%, rounded down, capped at 5m per item,
  // not charged on items selling under 50 gp, and a fixed exemption list.
  const TAX_RATE = 0.02;
  const TAX_CAP = 5_000_000;
  const TAX_FREE_BELOW = 50;
  // Tax-exempt item IDs (tools, bond, & a few staples per the GE tax rules).
  const TAX_EXEMPT = new Set([
    13190, // Old school bond
    1755,  // Chisel
    5325,  // Gardening trowel
    1785,  // Glassblowing pipe
    1733,  // Needle
    233,   // Pestle and mortar
    5341,  // Rake
    8794,  // Saw
    5329,  // Secateurs
    5343,  // Seed dibber
    1735,  // Shears
    952,   // Spade
    5331,  // Watering can
    2347,  // Hammer
  ]);

  const BUY_LIMIT_WINDOWS_PER_DAY = 6; // 4-hour buy-limit reset → 6 windows/day
  const CACHE = { mapping: 'gpp.mapping.v1', settings: 'gpp.settings.v1', journal: 'gpp.journal.v1' };
  const MAPPING_TTL = 24 * 60 * 60 * 1000; // 1 day
  const FETCH_TIMEOUT = 15_000;

  // --- Realism guards ---------------------------------------------------
  // The live "instabuy/instasell" prices can be stale or manipulated single
  // prints on thinly-traded items, producing fantasy margins like "buy 21,
  // sell 5k". These keep the engine honest:
  //   • OUTLIER_FACTOR — reject a price that sits more than Nx above (or 1/Nx
  //     below) the recent average; that spread isn't real.
  //   • MARKET_CAPTURE — the share of an item's *daily* volume you can
  //     realistically buy AND offload in one ~4h cycle. Caps plan quantities
  //     so a rarely-traded item can't pretend to move thousands of units.
  const OUTLIER_FACTOR = 3;
  const MARKET_CAPTURE = 0.10;

  /* ===================================================================== *
   *  STRATEGIES
   *  Each defines sensible defaults + a scoring function. The scorer ranks
   *  raw opportunities; the planner then fits them to the player's budget.
   * ===================================================================== */
  const STRATEGIES = {
    short: {
      id: 'short',
      name: 'Short Term',
      blurb: 'High-volume staples that flip in minutes. Small margins, but you cycle your gold fast - ideal if you can babysit the offers.',
      horizon: 'Minutes–hours',
      defaults: { minVolume: 10_000, minRoi: 0.005, maxRoi: 0.10, maxAgeMin: 60 },
      // Reward realised profit per day = per-item margin × what you can
      // actually flip per cycle × the number of cycles.
      score(m) {
        return m.profit * m.realisticUnits * BUY_LIMIT_WINDOWS_PER_DAY * (1 + m.roi);
      },
    },
    long: {
      id: 'long',
      name: 'Long Term',
      blurb: 'Fat absolute margins on slower-moving, often pricier items. Park your gold, check back later. Fewer offers to manage.',
      horizon: 'Hours–days',
      defaults: { minVolume: 100, minRoi: 0.02, maxRoi: 0.25, maxAgeMin: 6 * 60 },
      // Reward big per-item profit you can actually fill, weighted by margin.
      score(m) {
        return m.profit * Math.max(1, m.realisticUnits) * (1 + m.roi * 2);
      },
    },
    risky: {
      id: 'risky',
      name: 'Risky',
      blurb: 'Wide spreads and volatile movers. The biggest % returns live here - and so does the chance a price snaps back before you sell.',
      horizon: 'Unpredictable',
      defaults: { minVolume: 50, minRoi: 0.05, maxRoi: 0.60, maxAgeMin: 6 * 60 },
      // Reward ROI and volatility, but still require it to be tradeable.
      score(m) {
        return m.roi * (1 + m.volatility * 3) * Math.sqrt(m.profit * Math.max(1, m.realisticUnits));
      },
    },
    balanced: {
      id: 'balanced',
      name: 'Balanced',
      blurb: 'A safe all-rounder: healthy volume, decent margin, fresh prices. The default if you just want solid, low-drama flips.',
      horizon: 'Hours',
      defaults: { minVolume: 2_000, minRoi: 0.015, maxRoi: 0.15, maxAgeMin: 3 * 60 },
      score(m) {
        return m.profit * m.realisticUnits * BUY_LIMIT_WINDOWS_PER_DAY * (1 + m.roi * 1.5);
      },
    },
  };

  /* ===================================================================== *
   *  STATE
   * ===================================================================== */
  const state = {
    stack: 10_000_000,
    strategy: 'short',
    account: 'members',
    filters: { minVolume: 'auto', maxPrice: 'none', minRoi: 'auto', maxRoi: 'auto', diversify: 8 },
    autoRefresh: false,
    // data
    mapping: null,      // Map<id, meta>
    plan: [],           // current allocated plan rows
    lastUpdated: null,
    sort: { key: 'profit', dir: 'desc' },
    autoTimer: null,
  };

  /* ===================================================================== *
   *  FORMATTING - OSRS conventions (1k, 100m, 2.1b)
   * ===================================================================== */
  const Fmt = {
    /** Compact OSRS shorthand: 532 → "532", 12_300 → "12.3k", 1_500_000 → "1.5m". */
    gp(n) {
      if (n == null || !isFinite(n)) return '-';
      const neg = n < 0;
      let v = Math.abs(n);
      let out;
      if (v < 1_000) out = String(Math.round(v));
      else if (v < 1_000_000) out = trim(v / 1_000) + 'k';
      else if (v < 1_000_000_000) out = trim(v / 1_000_000) + 'm';
      else out = trim(v / 1_000_000_000) + 'b';
      return (neg ? '-' : '') + out;
    },
    /** Full grouped number for tooltips: 1500000 → "1,500,000". */
    full(n) {
      if (n == null || !isFinite(n)) return '-';
      return Math.round(n).toLocaleString('en-US');
    },
    /** Percentage: 0.0234 → "2.34%". */
    pct(n, dp = 2) {
      if (n == null || !isFinite(n)) return '-';
      return (n * 100).toFixed(dp) + '%';
    },
    /** Relative age: 65 → "1h 5m ago". */
    ago(minutes) {
      if (minutes == null || !isFinite(minutes)) return 'unknown';
      const m = Math.max(0, Math.round(minutes));
      if (m < 1) return 'just now';
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      const rem = m % 60;
      if (h < 24) return rem ? `${h}h ${rem}m ago` : `${h}h ago`;
      const d = Math.floor(h / 24);
      return `${d}d ago`;
    },
    /** RS coin-stack colour class by magnitude. */
    coinClass(n) {
      const v = Math.abs(n);
      if (v >= 10_000_000) return 'gp--green';
      if (v >= 100_000) return 'gp--white';
      return 'gp--yellow';
    },
  };

  function trim(x) {
    // 1.0 → "1", 1.50 → "1.5", 12.34 → "12.3"
    const dp = x >= 100 ? 0 : x >= 10 ? 1 : 2;
    return parseFloat(x.toFixed(dp)).toString();
  }

  /**
   * Parse OSRS gp shorthand into an integer.
   * Accepts: "100m", "1.5b", "250k", "1,000,000", "5 000", "2.5m".
   * Returns NaN if unparseable.
   */
  function parseGp(input) {
    if (typeof input === 'number') return input;
    if (!input) return NaN;
    const s = String(input).trim().toLowerCase().replace(/[,\s]/g, '').replace(/gp$/, '');
    const match = s.match(/^(\d*\.?\d+)([kmbt]?)$/);
    if (!match) return NaN;
    const base = parseFloat(match[1]);
    const mult = { '': 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[match[2]];
    return Math.round(base * mult);
  }

  /** Parse a percentage filter ("1.5%", "0.02", "2") into a fraction. */
  function parsePct(input) {
    if (input == null) return NaN;
    const s = String(input).trim().toLowerCase().replace('%', '');
    const n = parseFloat(s);
    if (!isFinite(n)) return NaN;
    // "1.5%" or "1.5" → 0.015 ; a bare fraction like "0.02" stays as-is.
    return s.includes('%') || n >= 1 ? n / 100 : n;
  }

  /* ===================================================================== *
   *  DOM HELPERS
   * ===================================================================== */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /** Cycle Tab/Shift+Tab focus within `container` (modal-dialog focus trap). */
  function trapTabKey(container, e) {
    if (e.key !== 'Tab') return;
    const f = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', container)
      .filter((node) => !node.disabled && node.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c.nodeType ? c : document.createTextNode(c));
    }
    return node;
  }

  /* ===================================================================== *
   *  STORAGE
   * ===================================================================== */
  const Store = {
    get(key) {
      try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
    },
    set(key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* quota / private mode */ }
    },
  };

  /* ===================================================================== *
   *  API
   * ===================================================================== */
  async function fetchJson(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  const Api = {
    /** Item metadata, cached for a day (it changes only on game updates). */
    async mapping() {
      const cached = Store.get(CACHE.mapping);
      if (cached && Date.now() - cached.t < MAPPING_TTL && Array.isArray(cached.d)) {
        return cached.d;
      }
      const data = await fetchJson(`${API}/mapping`);
      Store.set(CACHE.mapping, { t: Date.now(), d: data });
      return data;
    },
    latest() { return fetchJson(`${API}/latest`); },
    hour() { return fetchJson(`${API}/1h`); },
    day() { return fetchJson(`${API}/24h`); },
    timeseries(id, timestep = '5m') {
      return fetchJson(`${API}/timeseries?timestep=${timestep}&id=${id}`);
    },
  };

  /* ===================================================================== *
   *  ENGINE
   * ===================================================================== */
  function taxOf(sellPrice, id) {
    if (sellPrice < TAX_FREE_BELOW || TAX_EXEMPT.has(id)) return 0;
    return Math.min(Math.floor(sellPrice * TAX_RATE), TAX_CAP);
  }

  /**
   * Compute the flip economics for one item from the joined data slice.
   * Returns null if the item can't be sensibly flipped (no prices / no margin).
   */
  function computeMetrics(meta, latest, h1, h24, nowSec) {
    if (!latest || latest.high == null || latest.low == null) return null;

    const buy = latest.low;   // you acquire near the instasell (low) price
    const sell = latest.high; // you offload near the instabuy (high) price
    if (buy <= 0 || sell <= 0) return null;

    // Both sides must have actually traded, and BOTH must be recent: a flip
    // needs a live buy price AND a live sell price. Using the *older* of the
    // two timestamps means a dead sell-side print can't ride in on a fresh
    // buy-side one (the "buy 21, sell 5k" oak-shield bug).
    const tHigh = latest.highTime || 0;
    const tLow = latest.lowTime || 0;
    if (!tHigh || !tLow) return null;
    const ageMin = (nowSec - Math.min(tHigh, tLow)) / 60;

    // Outlier guard: reject prices that sit far outside the recent average.
    // Prefer the 1h average, fall back to 24h.
    const avgHigh = (h1 && h1.avgHighPrice) || (h24 && h24.avgHighPrice) || 0;
    const avgLow = (h1 && h1.avgLowPrice) || (h24 && h24.avgLowPrice) || 0;
    if (avgHigh && sell > avgHigh * OUTLIER_FACTOR) return null;  // inflated sell print
    if (avgLow && buy < avgLow / OUTLIER_FACTOR) return null;     // crashed buy print

    const tax = taxOf(sell, meta.id);
    const profit = sell - buy - tax;
    if (profit <= 0) return null;
    const roi = profit / buy;

    // Liquidity = units realistically tradeable on BOTH sides over 24h.
    const dHigh = (h24 && h24.highPriceVolume) || 0;
    const dLow = (h24 && h24.lowPriceVolume) || 0;
    const liquidity = Math.min(dHigh, dLow);     // bottleneck (thinner) side
    const dailyTotal = dHigh + dLow;

    const limit = meta.limit && meta.limit > 0 ? meta.limit : 100; // fallback when API has no limit

    // How many you can realistically buy AND offload in one cycle: capped by
    // the buy limit and by your share of the day's volume. A rarely-traded
    // item lands near zero here and simply can't carry a big plan.
    const realisticUnits = Math.min(limit, Math.floor(liquidity * MARKET_CAPTURE));

    // Volatility - how far the live mid has drifted from the average mid.
    let volatility = 0;
    if (avgHigh && avgLow) {
      const liveMid = (sell + buy) / 2;
      const avgMid = (avgHigh + avgLow) / 2;
      if (avgMid > 0) volatility = Math.abs(liveMid - avgMid) / avgMid;
    }

    return {
      id: meta.id,
      name: meta.name,
      examine: meta.examine,
      members: meta.members,
      icon: meta.icon,
      limit,
      highalch: meta.highalch,
      buy, sell, tax, profit, roi,
      liquidity,
      dailyTotal,
      realisticUnits,
      ageMin,
      volatility,
    };
  }

  /** Effective filter values, resolving "auto"/"none" against strategy defaults. */
  function resolveFilters(strategy) {
    const d = STRATEGIES[strategy].defaults;
    const f = state.filters;

    // The F2P market is a fraction of the members one - far fewer items and
    // thinner books - so the *auto* volume floor is relaxed to keep results.
    const acctVolFactor = state.account === 'f2p' ? 0.2 : 1;

    const autoVol = Math.round(d.minVolume * acctVolFactor);
    const minVolume = f.minVolume === 'auto' || f.minVolume === '' ? autoVol : parseGp(f.minVolume);
    const minRoi = f.minRoi === 'auto' || f.minRoi === '' ? d.minRoi : parsePct(f.minRoi);
    const maxRoi = f.maxRoi === 'auto' || f.maxRoi === '' || f.maxRoi == null ? d.maxRoi : parsePct(f.maxRoi);
    const maxPrice = f.maxPrice === 'none' || f.maxPrice === '' ? Infinity : parseGp(f.maxPrice);

    return {
      minVolume: isFinite(minVolume) ? minVolume : autoVol,
      minRoi: isFinite(minRoi) ? minRoi : d.minRoi,
      maxRoi: isFinite(maxRoi) ? maxRoi : d.maxRoi,
      maxPrice: isFinite(maxPrice) ? maxPrice : Infinity,
      maxAgeMin: d.maxAgeMin,
    };
  }

  /**
   * Full pipeline: join → filter → score → rank.
   * Returns an array of metric objects sorted best-first for the strategy.
   */
  function rankOpportunities(joined, strategy) {
    const strat = STRATEGIES[strategy];
    const f = resolveFilters(strategy);
    const wantMembers = state.account === 'members';

    const ranked = [];
    for (const m of joined) {
      if (!m) continue;
      if (!wantMembers && m.members) continue;            // F2P filter
      if (m.buy > f.maxPrice) continue;                   // single-item price cap
      if (m.liquidity < f.minVolume) continue;            // liquidity floor
      if (m.realisticUnits < 1) continue;                 // can't move even 1/cycle
      if (m.roi < f.minRoi) continue;                     // margin floor
      if (m.roi > f.maxRoi) continue;                     // sanity ceiling (artifact guard)
      if (m.ageMin > f.maxAgeMin) continue;               // stale-price guard
      m.score = strat.score(m);
      if (!isFinite(m.score) || m.score <= 0) continue;
      ranked.push(m);
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked;
  }

  /**
   * Greedily allocate the coin stack across the ranked opportunities,
   * respecting each item's buy limit and the diversification cap.
   * Each plan row = a concrete "buy N at X, sell at Y" instruction.
   */
  function buildPlan(ranked, stack, maxItems) {
    const plan = [];
    let remaining = stack;

    for (const m of ranked) {
      if (plan.length >= maxItems) break;
      if (remaining < m.buy) continue; // can't afford even one

      const affordable = Math.floor(remaining / m.buy);
      // Quantity is the lesser of what you can afford and what the market can
      // realistically absorb this cycle (already buy-limit + volume capped).
      const qty = Math.min(m.realisticUnits, affordable);
      if (qty < 1) continue;

      const capReason = qty < m.realisticUnits
        ? 'your coin stack'
        : (m.realisticUnits === m.limit ? 'the 4h buy limit' : 'realistic daily volume');

      const outlay = qty * m.buy;
      const profit = qty * m.profit;
      plan.push({ ...m, qty, outlay, planProfit: profit, capReason });
      remaining -= outlay;

      if (remaining < 1_000) break; // effectively spent
    }
    return plan;
  }

  /* ===================================================================== *
   *  ANALYSIS ORCHESTRATION
   * ===================================================================== */
  let running = false;

  async function analyse() {
    if (running) return;
    running = true;
    UI.setBusy(true);
    UI.status('loading', 'Reading the Grand Exchange…');

    try {
      // The three price feeds are always re-fetched; the mapping is only
      // loaded (and parsed) the first time - afterwards it lives in memory.
      const [mappingArr, latest, h1, h24] = await Promise.all([
        state.mapping ? null : Api.mapping(),
        Api.latest(),
        Api.hour(),
        Api.day(),
      ]);

      if (!state.mapping) {
        state.mapping = new Map(mappingArr.map((it) => [it.id, it]));
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const L = latest.data || {};
      const H = (h1 && h1.data) || {};
      const D = (h24 && h24.data) || {};

      const joined = [];
      for (const meta of state.mapping.values()) {
        const m = computeMetrics(meta, L[meta.id], H[meta.id], D[meta.id], nowSec);
        if (m) joined.push(m);
      }

      const ranked = rankOpportunities(joined, state.strategy);
      const maxItems = clamp(parseInt(state.filters.diversify, 10) || 8, 1, 30);
      state.plan = buildPlan(ranked, state.stack, maxItems);
      state.lastUpdated = Date.now();

      UI.renderResults();
      UI.status('ok', `Found ${ranked.length.toLocaleString()} flippable items.`);
      const profit = state.plan.reduce((s, r) => s + r.planProfit, 0);
      UI.announce(state.plan.length
        ? `${state.plan.length} flips found. Estimated profit ${Fmt.gp(profit)} per cycle.`
        : 'No flips matched your filters.');
      UI.updatedMeta();
    } catch (err) {
      console.error(err);
      const msg = /abort/i.test(err.message)
        ? 'The Grand Exchange took too long to respond. Try again.'
        : `Couldn't reach the price data (${err.message}).`;
      UI.status('error', 'Market read failed.');
      UI.announce('Market read failed. ' + msg);
      UI.toast(msg, 'error');
      UI.showPlaceholderError();
    } finally {
      running = false;
      UI.setBusy(false);
    }
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  /* ===================================================================== *
   *  UI
   * ===================================================================== */
  const dom = {};
  const UI = {
    cache() {
      Object.assign(dom, {
        statusDot: $('#status-dot'),
        statusText: $('#status-text'),
        srStatus: $('#sr-status'),
        stackInput: $('#stack-input'),
        stackParsed: $('#stack-parsed'),
        strategyTabs: $('#strategy-tabs'),
        strategyBlurb: $('#strategy-blurb'),
        accountToggle: $('#account-toggle'),
        minVolume: $('#min-volume'),
        maxPrice: $('#max-price'),
        minRoi: $('#min-roi'),
        maxRoi: $('#max-roi'),
        diversify: $('#diversify'),
        autoRefresh: $('#auto-refresh'),
        calcBtn: $('#calc-btn'),
        updatedMeta: $('#updated-meta'),
        summary: $('#summary'),
        statOutlay: $('#stat-outlay'),
        statProfit: $('#stat-profit'),
        statRoi: $('#stat-roi'),
        statHorizon: $('#stat-horizon'),
        resultsBar: $('#results-bar'),
        resultsNote: $('#results-note'),
        tableWrap: $('#table-wrap'),
        flipBody: $('#flip-body'),
        flipTable: $('#flip-table'),
        placeholder: $('#placeholder'),
        loader: $('#loader'),
        drawer: $('#drawer'),
        toasts: $('#toasts'),
      });
    },

    status(stateName, text) {
      dom.statusDot.dataset.state = stateName;
      dom.statusText.textContent = text;
    },

    /** Push a concise message to the screen-reader-only live region. */
    announce(text) {
      // Clear first so identical consecutive messages are still re-announced.
      dom.srStatus.textContent = '';
      requestAnimationFrame(() => { dom.srStatus.textContent = text; });
    },

    setBusy(busy) {
      dom.calcBtn.disabled = busy;
      dom.calcBtn.querySelector('.btn__label').textContent = busy ? 'Crunching…' : 'Find me flips';
      dom.loader.hidden = !busy;
      if (busy) {
        this.announce('Reading the Grand Exchange…');
        dom.placeholder.hidden = true;
        // keep prior results visible underneath the loader? hide for clarity
        dom.summary.hidden = true;
        dom.resultsBar.hidden = true;
        dom.tableWrap.hidden = true;
      }
    },

    showPlaceholderError() {
      dom.placeholder.hidden = false;
      $('.placeholder__title', dom.placeholder).textContent = 'Market read failed';
      $('.placeholder__text', dom.placeholder).innerHTML =
        'GP Printer couldn\'t fetch live prices. Check your connection and hit <b>Find me flips</b> again. ' +
        'If you opened this file directly, serve it over a local web server (see the README).';
    },

    updatedMeta() {
      if (!state.lastUpdated) { dom.updatedMeta.textContent = 'Prices not loaded yet.'; return; }
      const time = new Date(state.lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      dom.updatedMeta.textContent = `Prices updated ${time}`;
    },

    stackEcho() {
      const n = parseGp(dom.stackInput.value);
      if (!isFinite(n) || n <= 0) {
        dom.stackParsed.innerHTML = '<span style="color:var(--neg)">Enter a coin amount, e.g. 100m</span>';
        return false;
      }
      state.stack = n;
      dom.stackParsed.innerHTML = `Flipping with <b>${Fmt.gp(n)}</b> &middot; <span style="color:var(--ink-faint)">${Fmt.full(n)} gp</span>`;
      return true;
    },

    /** Build a coin <span> with magnitude colour + full-number tooltip. */
    coin(n, extraClass = '') {
      return el('span', {
        class: `gp ${Fmt.coinClass(n)} ${extraClass}`.trim(),
        title: `${Fmt.full(n)} gp`,
      }, Fmt.gp(n));
    },

    renderResults() {
      const plan = state.plan;
      if (!plan.length) {
        dom.summary.hidden = true;
        dom.resultsBar.hidden = true;
        dom.tableWrap.hidden = true;
        dom.placeholder.hidden = false;
        $('.placeholder__title', dom.placeholder).textContent = 'No flips matched';
        $('.placeholder__text', dom.placeholder).innerHTML =
          'Nothing cleared your filters for this style and stack. Try a bigger coin stack, a different flipping style, or loosen the <b>Advanced filters</b>.';
        return;
      }
      dom.placeholder.hidden = true;

      // --- Summary ---
      const totalOutlay = plan.reduce((s, r) => s + r.outlay, 0);
      const totalProfit = plan.reduce((s, r) => s + r.planProfit, 0);
      const blendedRoi = totalOutlay > 0 ? totalProfit / totalOutlay : 0;

      dom.statOutlay.replaceChildren(this.coin(totalOutlay));
      dom.statProfit.replaceChildren(this.coin(totalProfit, 'gp--profit'));
      dom.statRoi.textContent = Fmt.pct(blendedRoi);
      dom.statHorizon.textContent = STRATEGIES[state.strategy].horizon;
      dom.summary.hidden = false;

      // --- Results bar note ---
      dom.resultsBar.hidden = false;
      const utilised = state.stack > 0 ? totalOutlay / state.stack : 0;
      dom.resultsNote.innerHTML =
        `${plan.length} item${plan.length > 1 ? 's' : ''} &middot; ${Fmt.pct(utilised, 0)} of your stack deployed &middot; ` +
        `tap a row for the trade plan & price history`;

      // --- Table ---
      this.renderTable();
      dom.tableWrap.hidden = false;
    },

    renderTable() {
      const { key, dir } = state.sort;
      const rows = [...state.plan].sort((a, b) => {
        const av = sortVal(a, key), bv = sortVal(b, key);
        if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
        return dir === 'asc' ? av - bv : bv - av;
      });

      // Reflect the active sort on the column headers via aria-sort.
      $$('#flip-table thead th').forEach((th) => {
        const btn = $('.th-sort', th);
        th.setAttribute('aria-sort', btn && btn.dataset.sort === key
          ? (dir === 'asc' ? 'ascending' : 'descending')
          : 'none');
      });

      dom.flipBody.replaceChildren(...rows.map((r) => this.row(r)));
    },

    row(r) {
      const tags = [];
      if (r.volatility >= 0.06) tags.push(el('span', { class: 'item-cell__tag tag--volatile', title: `Live price is ${Fmt.pct(r.volatility, 1)} off the 1h average` }, 'volatile'));
      if (r.ageMin > 60) tags.push(el('span', { class: 'item-cell__tag tag--stale', title: `Last traded ${Fmt.ago(r.ageMin)}` }, 'thin'));
      if (r.liquidity > 100_000 && r.ageMin <= 30) tags.push(el('span', { class: 'item-cell__tag tag--hot', title: 'Heavy, fresh volume' }, 'hot'));

      const icon = el('img', { class: 'item-cell__icon', alt: '', loading: 'lazy', width: 32, height: 32 });
      setItemIcon(icon, r);

      const nameCell = el('td', { class: 'col-item' },
        el('div', { class: 'item-cell' }, icon,
          el('span', { class: 'item-cell__name' },
            r.name,
            r.members ? el('span', { class: 'members-star', title: 'Members item' }, '★') : null,
            ...tags,
          ),
        ),
      );

      const roiClass = r.roi >= 0.05 ? 'roi-hot' : 'roi-pos';

      const tr = el('tr', { tabindex: '0', role: 'button', 'aria-label': `View plan for ${r.name}` },
        nameCell,
        el('td', { class: 'col-num' }, this.coin(r.buy)),
        el('td', { class: 'col-num' }, this.coin(r.sell)),
        el('td', { class: 'col-num', title: `Capped by ${r.capReason} · buy limit ${Fmt.full(r.limit)}/4h · ~${Fmt.full(r.liquidity)} traded/day` }, Fmt.full(r.qty)),
        el('td', { class: 'col-num' }, this.coin(r.outlay)),
        el('td', { class: 'col-num' }, this.coin(r.planProfit, 'gp--profit')),
        el('td', { class: `col-num ${roiClass}` }, Fmt.pct(r.roi)),
        el('td', { class: 'col-num col-vol', title: `${Fmt.full(r.dailyTotal)} units traded in 24h` }, Fmt.gp(r.liquidity)),
      );
      tr.addEventListener('click', () => Drawer.open(r));
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); Drawer.open(r); } });
      return tr;
    },

    toast(msg, kind = '') {
      const t = el('div', { class: `toast ${kind ? 'toast--' + kind : ''}` }, msg);
      dom.toasts.append(t);
      setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 4200);
    },
  };

  function sortVal(r, key) {
    switch (key) {
      case 'name': return r.name;
      case 'buy': return r.buy;
      case 'sell': return r.sell;
      case 'qty': return r.qty;
      case 'outlay': return r.outlay;
      case 'profit': return r.planProfit;
      case 'roi': return r.roi;
      case 'vol24': return r.liquidity;
      default: return r.planProfit;
    }
  }

  /* ===================================================================== *
   *  DRAWER (item detail + price history chart + plain-language plan)
   * ===================================================================== */
  const Drawer = {
    open(r) {
      const d = dom.drawer;
      this.lastFocus = document.activeElement;
      this.current = r;
      // Reset the commit button to its default state each time.
      const commit = $('#drawer-commit', d);
      commit.textContent = 'Commit this flip to journal';
      commit.classList.remove('drawer__commit--done');
      commit.disabled = false;
      setItemIcon($('#drawer-icon', d), r);
      $('#drawer-title', d).textContent = r.name;
      $('#drawer-examine', d).textContent = r.examine || '';

      // Stat grid
      const stats = [
        ['Buy at', Fmt.full(r.buy) + ' gp'],
        ['Sell at', Fmt.full(r.sell) + ' gp'],
        ['Margin / item', Fmt.full(r.profit) + ' gp'],
        ['GE tax / item', r.tax ? Fmt.full(r.tax) + ' gp' : 'exempt'],
        ['Return', Fmt.pct(r.roi)],
        ['Buy limit', Fmt.full(r.limit) + ' / 4h'],
        ['Volume (24h)', Fmt.full(r.dailyTotal)],
        ['Last traded', Fmt.ago(r.ageMin)],
        ['High alch', r.highalch ? Fmt.full(r.highalch) + ' gp' : '-'],
        ['Volatility', Fmt.pct(r.volatility, 1)],
      ];
      $('#drawer-stats', d).replaceChildren(...stats.map(([k, v]) =>
        el('div', {}, el('dt', {}, k), el('dd', {}, v))));

      // Plain-language plan
      const cycleProfit = r.planProfit;
      $('#drawer-instructions', d).innerHTML = `
        <span class="step">1. Place a <b>buy offer</b> for <b>${Fmt.full(r.qty)}× ${r.name}</b> at <b>${Fmt.full(r.buy)} gp</b> each (${Fmt.gp(r.outlay)} total).</span>
        <span class="step">2. Once filled, <b>sell</b> them at <b>${Fmt.full(r.sell)} gp</b> each.</span>
        <span class="step">3. After the 2% tax you pocket about <b style="color:var(--pos)">${Fmt.gp(cycleProfit)}</b> &mdash; a ${Fmt.pct(r.roi)} return on this flip.</span>
        <span class="step" style="color:var(--ink-faint)">Buy limit resets every 4 hours, so you can repeat this up to ${BUY_LIMIT_WINDOWS_PER_DAY}× per day.</span>
      `;

      // Chart (lazy fetch)
      const chart = $('#drawer-chart', d);
      chart.innerHTML = '<div class="chart-empty">Loading price history…</div>';
      d.hidden = false;
      document.body.style.overflow = 'hidden';
      // Move focus into the dialog so keyboard/SR users land inside the modal.
      $('.drawer__close', d).focus();
      this.loadChart(r.id, chart);
    },

    close() {
      if (dom.drawer.hidden) return;
      dom.drawer.hidden = true;
      document.body.style.overflow = '';
      // Return focus to whatever opened the drawer (usually the table row).
      if (this.lastFocus && document.contains(this.lastFocus)) this.lastFocus.focus();
      this.lastFocus = null;
    },

    /** Keep Tab focus cycling within the open dialog (aria-modal contract). */
    trapFocus(e) {
      if (!dom.drawer.hidden) trapTabKey(dom.drawer, e);
    },

    async loadChart(id, container) {
      try {
        const res = await Api.timeseries(id, '5m');
        const series = (res.data || []).filter((p) => p.avgHighPrice || p.avgLowPrice);
        if (series.length < 2) { container.innerHTML = '<div class="chart-empty">Not enough trade history to chart.</div>'; return; }
        container.innerHTML = '';
        container.append(this.sparkline(series));
      } catch (err) {
        container.innerHTML = '<div class="chart-empty">Couldn\'t load price history.</div>';
      }
    },

    /** Dual-line SVG of high (sell) and low (buy) price over time. */
    sparkline(series) {
      const W = 380, H = 130, PAD = 6;
      const highs = series.map((p) => p.avgHighPrice).filter((v) => v != null);
      const lows = series.map((p) => p.avgLowPrice).filter((v) => v != null);
      const all = highs.concat(lows);
      const min = Math.min(...all), max = Math.max(...all);
      const range = max - min || 1;
      const n = series.length;
      const x = (i) => PAD + (i / (n - 1)) * (W - PAD * 2);
      const y = (v) => PAD + (1 - (v - min) / range) * (H - PAD * 2);

      const path = (accessor) => {
        let dStr = '';
        series.forEach((p, i) => {
          const v = accessor(p);
          if (v == null) return;
          dStr += (dStr ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) + ' ';
        });
        return dStr;
      };

      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', 'Price history: sell price (gold) and buy price (green)');

      const mk = (tag, attrs) => {
        const e = document.createElementNS(svgNS, tag);
        for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
        return e;
      };
      // baseline
      svg.append(mk('line', { class: 'spark-axis', x1: PAD, y1: H - PAD, x2: W - PAD, y2: H - PAD }));

      // Soft area fill under the sell line, then both lines on top.
      const highD = path((p) => p.avgHighPrice);
      const validHigh = series.map((p, i) => ({ i, v: p.avgHighPrice })).filter((o) => o.v != null);
      if (highD && validHigh.length > 1) {
        const fi = validHigh[0].i;
        const li = validHigh[validHigh.length - 1].i;
        const areaD = `${highD}L ${x(li).toFixed(1)} ${(H - PAD).toFixed(1)} L ${x(fi).toFixed(1)} ${(H - PAD).toFixed(1)} Z`;
        svg.append(mk('path', { class: 'spark-fill', d: areaD }));
      }
      svg.append(mk('path', { class: 'spark-line', d: highD }));
      svg.append(mk('path', { class: 'spark-line spark-line--low', d: path((p) => p.avgLowPrice) }));

      const wrap = el('div', {});
      wrap.append(svg);
      wrap.append(el('div', { style: 'display:flex;gap:14px;justify-content:center;font-size:14px;color:var(--ink-faint);margin-top:4px' },
        el('span', {}, el('span', { style: 'color:var(--gold)' }, '▬ '), 'sell ', el('b', { style: 'color:var(--gold-bright)' }, Fmt.gp(max))),
        el('span', {}, el('span', { style: 'color:var(--pos)' }, '▬ '), 'buy ', el('b', { style: 'color:var(--pos)' }, Fmt.gp(min))),
        el('span', { style: 'color:var(--ink-faint)' }, `${n} pts · last ~${Math.round(n * 5 / 60)}h`),
      ));
      return wrap;
    },
  };

  /* ===================================================================== *
   *  FLIP JOURNAL — persistent committed flips + performance tracking
   * ===================================================================== */

  function uid() {
    try { return crypto.randomUUID(); }
    catch { return 'f' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }
  }

  function isValidEntry(e) {
    return e && typeof e === 'object' && e.id != null && e.itemId != null
      && e.plannedBuy != null && e.plannedSell != null && e.plannedQty != null;
  }

  function normaliseEntry(e) {
    const num = (v) => (v != null && isFinite(+v) ? +v : null);
    return {
      id: String(e.id),
      itemId: +e.itemId,
      itemName: e.itemName || ('Item ' + e.itemId),
      icon: e.icon || '',
      members: !!e.members,
      plannedBuy: +e.plannedBuy, plannedSell: +e.plannedSell, plannedQty: +e.plannedQty,
      actualBuy: num(e.actualBuy), actualSell: num(e.actualSell), actualQty: num(e.actualQty),
      status: ['open', 'done', 'cancelled'].includes(e.status) ? e.status : 'open',
      committedAt: num(e.committedAt) || Date.now(),
      completedAt: num(e.completedAt),
      notes: typeof e.notes === 'string' ? e.notes : '',
    };
  }

  /** Effective economics for an entry — actuals override the committed plan. */
  function entryEconomics(e) {
    const buy = e.actualBuy != null ? e.actualBuy : e.plannedBuy;
    const sell = e.actualSell != null ? e.actualSell : e.plannedSell;
    const qty = e.actualQty != null ? e.actualQty : e.plannedQty;
    const taxPer = sell > 0 ? taxOf(sell, e.itemId) : 0;
    return {
      buy, sell, qty, taxPer,
      profit: Math.round(qty * (sell - buy - taxPer)),
      invested: Math.round(qty * buy),
      roi: qty * buy > 0 ? (sell - buy - taxPer) / buy : 0,
    };
  }

  const Journal = {
    entries: [],

    load() {
      const data = Store.get(CACHE.journal);
      this.entries = Array.isArray(data) ? data.filter(isValidEntry).map(normaliseEntry) : [];
    },
    save() { Store.set(CACHE.journal, this.entries); },

    get(id) { return this.entries.find((x) => x.id === id); },
    remove(id) { this.entries = this.entries.filter((x) => x.id !== id); this.save(); },
    clear() { this.entries = []; this.save(); },
    update(id, patch) {
      const e = this.get(id);
      if (e) { Object.assign(e, patch); this.save(); }
      return e;
    },

    /** Snapshot a plan row as a new OPEN journal entry. */
    commit(r) {
      const entry = normaliseEntry({
        id: uid(), itemId: r.id, itemName: r.name, icon: r.icon, members: r.members,
        plannedBuy: r.buy, plannedSell: r.sell, plannedQty: r.qty,
        status: 'open', committedAt: Date.now(),
      });
      this.entries.unshift(entry);
      this.save();
      return entry;
    },

    list(filter) {
      return filter && filter !== 'all' ? this.entries.filter((e) => e.status === filter) : this.entries;
    },

    /** Lifetime performance across completed flips. */
    metrics() {
      const done = this.entries.filter((e) => e.status === 'done');
      const open = this.entries.filter((e) => e.status === 'open');
      let realized = 0, invested = 0, wins = 0, taxPaid = 0, best = null;
      for (const e of done) {
        const ec = entryEconomics(e);
        realized += ec.profit; invested += ec.invested; taxPaid += ec.taxPer * ec.qty;
        if (ec.profit > 0) wins++;
        if (!best || ec.profit > best.profit) best = { name: e.itemName, profit: ec.profit };
      }
      return {
        doneCount: done.length, openCount: open.length,
        realized, invested,
        roi: invested > 0 ? realized / invested : 0,
        winRate: done.length ? wins / done.length : 0,
        avgPerFlip: done.length ? Math.round(realized / done.length) : 0,
        taxPaid: Math.round(taxPaid),
        openProjected: open.reduce((s, e) => s + entryEconomics(e).profit, 0),
        best,
      };
    },

    /** Cumulative realised profit, ordered by completion time. */
    cumulativeSeries() {
      const done = this.entries.filter((e) => e.status === 'done')
        .slice().sort((a, b) => (a.completedAt || a.committedAt) - (b.completedAt || b.committedAt));
      let cum = 0;
      return done.map((e) => { cum += entryEconomics(e).profit; return cum; });
    },

    exportPayload() {
      return { app: 'GP Printer', type: 'flip-journal', version: 1, exportedAt: new Date().toISOString(), entries: this.entries };
    },

    /** Merge imported entries, de-duped by id. Returns {added, skipped}. */
    importPayload(payload) {
      const incoming = Array.isArray(payload) ? payload
        : (payload && Array.isArray(payload.entries) ? payload.entries : null);
      if (!incoming) throw new Error('unrecognised file format');
      const have = new Set(this.entries.map((e) => e.id));
      let added = 0, skipped = 0;
      for (const raw of incoming) {
        if (!isValidEntry(raw) || have.has(String(raw.id))) { skipped++; continue; }
        have.add(String(raw.id));
        this.entries.push(normaliseEntry(raw));
        added++;
      }
      this.entries.sort((a, b) => b.committedAt - a.committedAt);
      this.save();
      return { added, skipped };
    },
  };

  /* --- small SVG helper for the cumulative chart --- */
  function svgEl(tag, attrs) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }

  function cumulativeChart(series) {
    const W = 760, H = 150, PAD = 10;
    const min = Math.min(0, ...series), max = Math.max(0, ...series);
    const range = (max - min) || 1;
    const n = series.length;
    const x = (i) => PAD + (n === 1 ? 0 : (i / (n - 1)) * (W - PAD * 2));
    const y = (v) => PAD + (1 - (v - min) / range) * (H - PAD * 2);
    let d = '';
    series.forEach((v, i) => { d += (d ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) + ' '; });
    const last = series[series.length - 1];
    const colour = last >= 0 ? 'var(--pos)' : 'var(--neg)';
    const zeroY = y(0).toFixed(1);

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Cumulative realised profit: ${Fmt.gp(last)}` });
    svg.append(svgEl('line', { class: 'spark-axis', x1: PAD, y1: zeroY, x2: W - PAD, y2: zeroY }));
    const area = svgEl('path', { d: `${d}L ${x(n - 1).toFixed(1)} ${zeroY} L ${x(0).toFixed(1)} ${zeroY} Z`, fill: colour, 'fill-opacity': '0.12' });
    svg.append(area);
    svg.append(svgEl('path', { d, fill: 'none', stroke: colour, 'stroke-width': '2' }));
    return svg;
  }

  const JournalUI = {
    filter: 'all',
    open: false,

    init() {
      const s = Store.get(CACHE.settings) || {};
      this.filter = ['all', 'open', 'done', 'cancelled'].includes(s.journalFilter) ? s.journalFilter : 'all';
      this.open = !!s.journalOpen;
      this.applyFilterButtons();
      $('#journal-toggle').setAttribute('aria-expanded', String(this.open));
      $('#journal-body').hidden = !this.open;
      this.render();
    },

    toggle(force) {
      this.open = force != null ? force : !this.open;
      $('#journal-toggle').setAttribute('aria-expanded', String(this.open));
      $('#journal-body').hidden = !this.open;
      saveSettings();
      if (this.open) this.render();
    },

    applyFilterButtons() {
      $$('#journal-filters [role="radio"]').forEach((b) => {
        const on = b.dataset.filter === this.filter;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      });
    },

    setFilter(f) {
      this.filter = f;
      this.applyFilterButtons();
      saveSettings();
      this.renderTable();
    },

    render() {
      this.renderChips();
      this.renderMetrics();
      this.renderChart();
      this.renderTable();
    },

    chip(text, value, kind) {
      const c = el('span', { class: `jchip ${kind ? 'jchip--' + kind : ''}`.trim() }, text);
      if (value != null) c.append(el('b', {}, value));
      return c;
    },

    renderChips() {
      const m = Journal.metrics();
      const net = m.realized;
      $('#journal-chips').replaceChildren(
        this.chip(`${m.openCount} open`),
        this.chip(`${m.doneCount} done`),
        this.chip('net ', Fmt.gp(net), net >= 0 ? 'profit' : 'loss'),
      );
    },

    renderMetrics() {
      const m = Journal.metrics();
      const card = (label, valueNode, sub) => el('article', { class: 'stat' },
        el('span', { class: 'stat__label' }, label),
        el('span', { class: 'stat__value' }, valueNode),
        sub ? el('span', { class: 'stat__label', style: 'text-transform:none;margin-top:2px' }, sub) : null,
      );
      const profitNode = el('span', { class: 'gp ' + (m.realized >= 0 ? 'gp--profit' : 'gp--loss'), title: Fmt.full(m.realized) + ' gp' }, Fmt.gp(m.realized));
      $('#journal-metrics').replaceChildren(
        card('Realised P/L', profitNode, m.openProjected ? `+${Fmt.gp(m.openProjected)} projected open` : null),
        card('Completed', String(m.doneCount), `${m.openCount} still open`),
        card('Win rate', m.doneCount ? Fmt.pct(m.winRate, 0) : '—', m.best ? `best ${Fmt.gp(m.best.profit)}` : null),
        card('Realised ROI', m.invested ? Fmt.pct(m.roi) : '—', m.doneCount ? `avg ${Fmt.gp(m.avgPerFlip)}/flip` : null),
      );
    },

    renderChart() {
      const series = Journal.cumulativeSeries();
      const card = $('#journal-chart-card');
      if (series.length < 2) { card.hidden = true; return; }
      card.hidden = false;
      $('#journal-chart').replaceChildren(cumulativeChart(series));
    },

    renderTable() {
      const rows = Journal.list(this.filter);
      const wrap = $('#journal-table-wrap');
      const empty = $('#journal-empty');
      if (!Journal.entries.length) {
        wrap.hidden = true; empty.hidden = false;
        empty.innerHTML = 'No committed flips yet. Open any flip from your plan and hit <b>Commit this flip to journal</b> to lock in the buy/sell prices &mdash; they\'ll stay here even after prices refresh.';
        return;
      }
      if (!rows.length) {
        wrap.hidden = true; empty.hidden = false;
        empty.textContent = `No ${this.filter} flips.`;
        return;
      }
      empty.hidden = true; wrap.hidden = false;
      $('#journal-body-rows').replaceChildren(...rows.map((e) => this.row(e)));
    },

    row(e) {
      const ec = entryEconomics(e);
      const icon = el('img', { class: 'item-cell__icon', alt: '', loading: 'lazy', width: 28, height: 28 });
      setItemIcon(icon, { id: e.itemId, icon: e.icon });

      const nameCell = el('td', { class: 'col-item' },
        el('div', { class: 'item-cell' }, icon,
          el('span', { class: 'item-cell__name' }, e.itemName,
            e.members ? el('span', { class: 'members-star', title: 'Members item' }, '★') : null)));

      const badge = el('td', {}, el('span', { class: `status-badge status-badge--${e.status}` }, e.status));

      let profitCell;
      if (e.status === 'cancelled') {
        profitCell = el('td', { class: 'col-num' }, '—');
      } else if (e.status === 'done') {
        profitCell = el('td', { class: 'col-num' },
          el('span', { class: 'gp ' + (ec.profit >= 0 ? 'gp--profit' : 'gp--loss'), title: Fmt.full(ec.profit) + ' gp' }, Fmt.gp(ec.profit)));
      } else {
        profitCell = el('td', { class: 'col-num' },
          el('span', { class: 'profit-projected', title: 'Projected from committed prices' }, Fmt.gp(ec.profit)));
      }

      const actions = el('td', { class: 'col-actions' },
        el('div', { class: 'row-actions' },
          e.status === 'open'
            ? el('button', { class: 'icon-btn icon-btn--done', title: 'Mark complete', 'aria-label': `Mark ${e.itemName} complete`, dataset: { action: 'done', id: e.id } }, '✓')
            : null,
          el('button', { class: 'icon-btn', title: 'Edit', 'aria-label': `Edit ${e.itemName}`, dataset: { action: 'edit', id: e.id } }, '✎'),
          el('button', { class: 'icon-btn icon-btn--del', title: 'Remove', 'aria-label': `Remove ${e.itemName}`, dataset: { action: 'del', id: e.id } }, '🗑'),
        ));

      return el('tr', {},
        nameCell, badge,
        el('td', { class: 'col-num' }, Fmt.full(ec.qty)),
        el('td', { class: 'col-num' }, UI.coin(ec.buy)),
        el('td', { class: 'col-num' }, UI.coin(ec.sell)),
        profitCell,
        el('td', { class: 'col-num col-date', title: new Date(e.committedAt).toLocaleString() },
          new Date(e.committedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })),
        actions,
      );
    },
  };

  const EntryEditor = {
    current: null,
    lastFocus: null,

    open(id, presetStatus) {
      const e = Journal.get(id);
      if (!e) return;
      this.current = e;
      this.lastFocus = document.activeElement;
      setItemIcon($('#entry-icon'), { id: e.itemId, icon: e.icon });
      $('#entry-title').textContent = e.itemName;
      $('#entry-sub').textContent = `Committed ${new Date(e.committedAt).toLocaleString()} · plan ${Fmt.full(e.plannedQty)} @ ${Fmt.gp(e.plannedBuy)}→${Fmt.gp(e.plannedSell)}`;
      $('#entry-status').value = presetStatus || e.status;
      $('#entry-qty').value = e.actualQty != null ? e.actualQty : e.plannedQty;
      $('#entry-buy').value = e.actualBuy != null ? e.actualBuy : e.plannedBuy;
      $('#entry-sell').value = e.actualSell != null ? e.actualSell : e.plannedSell;
      $('#entry-notes').value = e.notes || '';
      this.preview();
      $('#entry-modal').hidden = false;
      document.body.style.overflow = 'hidden';
      $('#entry-qty').focus();
      $('#entry-qty').select();
    },

    readForm() {
      return {
        buy: parseGp($('#entry-buy').value),
        sell: parseGp($('#entry-sell').value),
        qty: parseGp($('#entry-qty').value),
        status: $('#entry-status').value,
        notes: $('#entry-notes').value.trim(),
      };
    },

    preview() {
      const { buy, sell, qty, status } = this.readForm();
      const node = $('#entry-preview');
      if (status === 'cancelled') { node.innerHTML = 'Cancelled — no profit or loss recorded.'; return; }
      if (![buy, sell, qty].every(isFinite) || qty <= 0) { node.textContent = 'Enter quantity, buy and sell prices.'; return; }
      const taxPer = sell > 0 ? taxOf(sell, this.current.itemId) : 0;
      const profit = Math.round(qty * (sell - buy - taxPer));
      const invested = qty * buy;
      const roi = invested > 0 ? profit / invested : 0;
      const verb = status === 'done' ? 'Realised' : 'Projected';
      const colour = profit >= 0 ? 'var(--pos)' : 'var(--neg)';
      node.innerHTML = `${verb} profit <b style="color:${colour}">${Fmt.gp(profit)}</b> on ${Fmt.gp(invested)} invested · ${Fmt.pct(roi)} · after ${Fmt.gp(taxPer * qty)} GE tax.`;
    },

    save(ev) {
      ev.preventDefault();
      const e = this.current;
      if (!e) return;
      const { buy, sell, qty, status, notes } = this.readForm();
      if (![buy, sell, qty].every(isFinite) || qty <= 0 || buy < 0 || sell < 0) {
        UI.toast('Enter a valid quantity and prices.', 'error');
        return;
      }
      Journal.update(e.id, {
        actualBuy: buy, actualSell: sell, actualQty: qty, status, notes,
        completedAt: status === 'done' ? (e.completedAt || Date.now()) : null,
      });
      this.close();
      JournalUI.render();
      UI.toast('Flip updated.', 'ok');
    },

    del() {
      const e = this.current;
      if (!e) return;
      if (!window.confirm(`Remove this ${e.itemName} flip from your journal?`)) return;
      Journal.remove(e.id);
      this.close();
      JournalUI.render();
      UI.toast('Flip removed.');
    },

    close() {
      $('#entry-modal').hidden = true;
      document.body.style.overflow = '';
      if (this.lastFocus && document.contains(this.lastFocus)) this.lastFocus.focus();
      this.current = null;
    },
  };

  /* --- journal data import / export --- */
  function exportJournal() {
    if (!Journal.entries.length) { UI.toast('Nothing to export yet.'); return; }
    const json = JSON.stringify(Journal.exportPayload(), null, 2);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = el('a', { href: url, download: `gp-printer-journal-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    UI.toast(`Exported ${Journal.entries.length} flips.`, 'ok');
  }

  function importJournal(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const { added, skipped } = Journal.importPayload(JSON.parse(reader.result));
        JournalUI.render();
        if (added && !JournalUI.open) JournalUI.toggle(true);
        UI.toast(`Imported ${added} flip${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}.`, added ? 'ok' : '');
      } catch (err) {
        UI.toast(`Import failed: ${err.message}`, 'error');
      }
    };
    reader.onerror = () => UI.toast('Could not read that file.', 'error');
    reader.readAsText(file);
  }

  /* ===================================================================== *
   *  EVENTS
   * ===================================================================== */
  function wireEvents() {
    // Stack input - live echo + persist; Enter triggers analysis.
    dom.stackInput.addEventListener('input', () => { UI.stackEcho(); saveSettings(); });
    dom.stackInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') analyse(); });

    // Strategy radiogroup - click + arrow-key navigation, re-rank on change.
    dom.strategyTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('[role="radio"]');
      if (tab) chooseStrategy(tab.dataset.strategy);
    });
    wireRadioKeys(dom.strategyTabs, (btn) => chooseStrategy(btn.dataset.strategy));

    // Account radiogroup - click + arrow-key navigation.
    dom.accountToggle.addEventListener('click', (e) => {
      const btn = e.target.closest('[role="radio"]');
      if (btn) chooseAccount(btn.dataset.account);
    });
    wireRadioKeys(dom.accountToggle, (btn) => chooseAccount(btn.dataset.account));

    // Advanced filters
    const bindFilter = (node, key) => node.addEventListener('change', () => {
      state.filters[key] = node.value.trim();
      saveSettings();
      if (state.lastUpdated) analyse();
    });
    bindFilter(dom.minVolume, 'minVolume');
    bindFilter(dom.maxPrice, 'maxPrice');
    bindFilter(dom.minRoi, 'minRoi');
    bindFilter(dom.maxRoi, 'maxRoi');
    bindFilter(dom.diversify, 'diversify');

    // Auto-refresh
    dom.autoRefresh.addEventListener('change', () => {
      state.autoRefresh = dom.autoRefresh.checked;
      saveSettings();
      setupAutoRefresh();
    });

    // Calculate
    dom.calcBtn.addEventListener('click', () => { if (UI.stackEcho()) analyse(); });

    // Sortable headers - buttons, so Enter/Space/click all work for free.
    dom.flipTable.querySelector('thead').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-sort]');
      if (!btn) return;
      const key = btn.dataset.sort;
      if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      else state.sort = { key, dir: key === 'name' ? 'asc' : 'desc' };
      UI.renderTable();
      UI.announce(`Sorted by ${btn.textContent.trim()}, ${state.sort.dir === 'asc' ? 'ascending' : 'descending'}.`);
    });

    // Drawer - close on scrim/✕, trap focus while open.
    dom.drawer.addEventListener('click', (e) => { if (e.target.dataset.close !== undefined) Drawer.close(); });
    dom.drawer.addEventListener('keydown', (e) => Drawer.trapFocus(e));

    // Commit the open flip to the journal.
    $('#drawer-commit').addEventListener('click', () => {
      const r = Drawer.current;
      if (!r) return;
      Journal.commit(r);
      const btn = $('#drawer-commit');
      btn.textContent = 'Committed ✓';
      btn.classList.add('drawer__commit--done');
      btn.disabled = true;
      JournalUI.render();
      if (!JournalUI.open) { JournalUI.toggle(true); $('#journal').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
      UI.toast(`Committed: ${Fmt.full(r.qty)}× ${r.name}`, 'ok');
    });

    // Journal: collapse toggle.
    $('#journal-toggle').addEventListener('click', () => JournalUI.toggle());

    // Journal: status filter (click + arrow keys).
    const filters = $('#journal-filters');
    filters.addEventListener('click', (e) => {
      const b = e.target.closest('[role="radio"]');
      if (b) JournalUI.setFilter(b.dataset.filter);
    });
    wireRadioKeys(filters, (b) => JournalUI.setFilter(b.dataset.filter));

    // Journal: row actions (delegated).
    $('#journal-body-rows').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const { action, id } = btn.dataset;
      if (action === 'del') {
        const entry = Journal.get(id);
        if (entry && window.confirm(`Remove this ${entry.itemName} flip from your journal?`)) { Journal.remove(id); JournalUI.render(); UI.toast('Flip removed.'); }
      } else if (action === 'done') {
        EntryEditor.open(id, 'done');
      } else {
        EntryEditor.open(id);
      }
    });

    // Journal: import / export / clear.
    $('#journal-export').addEventListener('click', exportJournal);
    $('#journal-import').addEventListener('click', () => $('#journal-import-file').click());
    $('#journal-import-file').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) importJournal(file);
      e.target.value = ''; // allow re-importing the same file
    });
    $('#journal-clear').addEventListener('click', () => {
      if (!Journal.entries.length) { UI.toast('Journal is already empty.'); return; }
      if (window.confirm(`Delete all ${Journal.entries.length} journal entries? Export first if you want a backup. This cannot be undone.`)) {
        Journal.clear(); JournalUI.render(); UI.toast('Journal cleared.');
      }
    });

    // Entry editor modal.
    const modal = $('#entry-modal');
    modal.addEventListener('click', (e) => { if (e.target.dataset.close !== undefined) EntryEditor.close(); });
    modal.addEventListener('keydown', (e) => { if (!modal.hidden) trapTabKey(modal, e); });
    $('#entry-form').addEventListener('submit', (e) => EntryEditor.save(e));
    $('#entry-delete').addEventListener('click', () => EntryEditor.del());
    ['#entry-buy', '#entry-sell', '#entry-qty'].forEach((sel) =>
      $(sel).addEventListener('input', () => EntryEditor.preview()));
    $('#entry-status').addEventListener('change', () => EntryEditor.preview());

    // Global Escape closes whichever overlay is open.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!modal.hidden) EntryEditor.close();
      else if (!dom.drawer.hidden) Drawer.close();
    });
  }

  /** Arrow/Home/End keyboard navigation for an ARIA radiogroup of buttons. */
  function wireRadioKeys(container, onSelect) {
    container.addEventListener('keydown', (e) => {
      const items = $$('[role="radio"]', container);
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      let n;
      switch (e.key) {
        case 'ArrowRight': case 'ArrowDown': n = (i + 1) % items.length; break;
        case 'ArrowLeft': case 'ArrowUp': n = (i - 1 + items.length) % items.length; break;
        case 'Home': n = 0; break;
        case 'End': n = items.length - 1; break;
        default: return;
      }
      e.preventDefault();
      items[n].focus();
      onSelect(items[n]);
    });
  }

  /** Set aria-checked + roving tabindex across a radiogroup. */
  function setRadioState(container, selected) {
    $$('[role="radio"]', container).forEach((b) => {
      const on = b === selected;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }

  function chooseStrategy(id) {
    selectStrategy(id);
    saveSettings();
    if (state.lastUpdated) analyse(); // re-rank instantly if we already have data
  }

  function chooseAccount(account) {
    if (account !== 'members' && account !== 'f2p') return;
    state.account = account;
    setRadioState(dom.accountToggle, $(`[data-account="${account}"]`, dom.accountToggle));
    saveSettings();
    if (state.lastUpdated) analyse();
  }

  function selectStrategy(id) {
    if (!STRATEGIES[id]) return;
    state.strategy = id;
    setRadioState(dom.strategyTabs, $(`[data-strategy="${id}"]`, dom.strategyTabs));
    dom.strategyBlurb.textContent = STRATEGIES[id].blurb;
  }

  function setupAutoRefresh() {
    if (state.autoTimer) { clearInterval(state.autoTimer); state.autoTimer = null; }
    if (state.autoRefresh) {
      state.autoTimer = setInterval(() => { if (!running) analyse(); }, 60_000);
    }
  }

  /* ===================================================================== *
   *  SETTINGS PERSISTENCE
   * ===================================================================== */
  function saveSettings() {
    Store.set(CACHE.settings, {
      stack: dom.stackInput.value,
      strategy: state.strategy,
      account: state.account,
      filters: state.filters,
      autoRefresh: state.autoRefresh,
      journalOpen: JournalUI.open,
      journalFilter: JournalUI.filter,
    });
  }

  function loadSettings() {
    const s = Store.get(CACHE.settings);
    if (!s) {
      selectStrategy(state.strategy);
      setRadioState(dom.accountToggle, $(`[data-account="${state.account}"]`, dom.accountToggle));
      UI.stackEcho();
      return;
    }
    if (s.stack) dom.stackInput.value = s.stack;
    if (s.filters) {
      state.filters = { ...state.filters, ...s.filters };
      dom.minVolume.value = state.filters.minVolume;
      dom.maxPrice.value = state.filters.maxPrice;
      dom.minRoi.value = state.filters.minRoi;
      dom.maxRoi.value = state.filters.maxRoi;
      dom.diversify.value = state.filters.diversify;
    }
    if (typeof s.autoRefresh === 'boolean') { state.autoRefresh = s.autoRefresh; dom.autoRefresh.checked = s.autoRefresh; }
    state.account = s.account === 'f2p' ? 'f2p' : 'members';
    setRadioState(dom.accountToggle, $(`[data-account="${state.account}"]`, dom.accountToggle));
    selectStrategy(s.strategy || state.strategy);
    UI.stackEcho();
  }

  /* ===================================================================== *
   *  INIT
   * ===================================================================== */
  function init() {
    UI.cache();
    loadSettings();
    Journal.load();
    JournalUI.init();
    wireEvents();
    setupAutoRefresh();
    UI.status('idle', 'Ready to crunch the market.');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
