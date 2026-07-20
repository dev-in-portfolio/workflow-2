# Provider Mapping

The system uses a canonical asset normalization layer so downstream logic does not depend on provider-specific symbol shapes.

## Canonical Symbols

- Stocks and ETFs: uppercase ticker, for example `AAPL`, `MSFT`, `SPY`.
- Crypto: base/quote pairs, for example `BTC/USD`, `ETH/USDT`.
- Index and forex symbols can be normalized similarly when needed.

## Provider Chain

The default provider chain is defined in `config/provider-map.json`.

- Stocks:
  - Quote: `alpaca`, `twelvedata`, `massive`, `finnhub`
  - Candles: `alpaca`, `twelvedata`, `massive`
  - News: `finnhub`
  - Fundamentals/reference: `fmp`
  - Filings/risk context: `sec_edgar`
- Crypto:
  - Quote: `alpaca`, `binance`, `coinbase`
  - Candles: `alpaca`, `binance`, `coinbase`
  - News: `finnhub`

## Freshness Rules

- Reject missing timestamps.
- Reject stale quotes and candles.
- Reject suspicious zero-volume market data.
- Flag sharp price jumps for confirmation.
- If both Alpaca and Twelve Data are present for the same symbol, require the pair to agree before the signal is approved for paper.

## Reliability Scoring

Each normalized payload carries provider metadata, a freshness signal, and a reliability score so the signal layer can penalize weak or stale inputs.
