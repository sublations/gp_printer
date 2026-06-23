# GP Printer

A static, single-page **Old School RuneScape Grand Exchange flipping calculator**. It pulls live GE prices, trade volumes and price history, works out the flip economics for every tradeable item (margin **after** the 2% GE sales tax), and lays out a concrete, budget-aware plan for your coin stack:

> **Buy 70× Dragon bones at 2.6k, sell at 2.8k - ~9.8k profit, 4-hour limit.**

No build step, no dependencies, no backend. Just HTML + CSS + vanilla JS.

## The three views

- **Flip Finder** — enter your coin stack and flipping style; get a ranked, budget-allocated plan (quantities capped by the buy limit *and* realistic daily volume). Click any row for the full breakdown.
- **Explore Items** — search any item by name, or browse the market by **Most traded**, **Risers 24h**, **Fallers 24h**, or **Top margins**. Click an item for its price-history chart (selectable range), live stats, and a one-click commit.
- **Journal** — every flip you commit is saved locally with its prices locked in (it survives price refreshes). Track each to completion with actuals/deviations, and see lifetime analytics: realised P/L, win rate, ROI, average hold, a cumulative-profit chart, and profit-by-item. Export/import the history as JSON to back it up or move devices.

## How it works

| Stage | What happens |
|-------|--------------|
| **Ingest** | `mapping` (item metadata, cached 24h) + `latest`, `1h`, `24h` price/volume feeds from [prices.runescape.wiki](https://prices.runescape.wiki/). |
| **Economics** | For each item: `profit = sell − buy − tax`, `ROI = profit / buy`, plus liquidity (min of buy/sell daily volume), price freshness, and volatility (live mid vs. 1h average). |
| **Tax** | 2% of the sale, rounded down, capped at 5m, waived under 50 gp and for exempt items (tools, bond). |
| **Score** | Each flipping style ranks items differently (see below). |
| **Plan** | Greedily allocates your stack across the top items, respecting each item's 4-hour buy limit and your diversification cap. |

### Flipping styles

- **Short Term** - high-volume staples that cycle in minutes. Small margins, fast turnover.
- **Long Term** - fat absolute margins on slower, pricier items. Set and forget.
- **Risky** - wide spreads and volatile movers. Highest % returns, highest chance of a snap-back.
- **Balanced** - solid volume + margin + fresh prices. The safe default.

Click any row for the price-history chart and a step-by-step trade plan.

## Data sources

- [OSRS Wiki Real-time Prices API](https://prices.runescape.wiki/) - prices, volumes, history.
- [Official Grand Exchange Database](https://secure.runescape.com/m=itemdb_oldschool/) - item icons.

Not affiliated with Jagex. RuneScape is a trademark of Jagex Ltd. Merchanting is a legitimate, intended gameplay mechanic - see the [Merchanting wiki page](https://oldschool.runescape.wiki/w/Merchanting).
