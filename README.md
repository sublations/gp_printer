# GP Printer

A static, single-page **Old School RuneScape Grand Exchange flipping calculator**. It pulls live GE prices, trade volumes and price history, works out the flip economics for every tradeable item (margin **after** the 2% GE sales tax), and lays out a concrete, budget-aware plan for your coin stack:

> **Buy 70× Dragon bones at 2.6k, sell at 2.8k - ~9.8k profit, 4-hour limit.**

No build step, no dependencies, no backend. Just HTML + CSS + vanilla JS.

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
