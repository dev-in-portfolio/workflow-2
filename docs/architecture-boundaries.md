# Architecture Boundaries

This project supports a local Alpaca-capable live workflow. Alpaca broker state is the source of truth for account, positions, and open orders whenever live-capable execution is enabled.

## Scanner

The scanner fetches market data, builds and ranks candidates, records rank components and skip reasons, sends candidate decision requests, and writes scanner runtime state.

The scanner must not submit broker orders directly, assume local state beats Alpaca, or silently ignore unavailable broker state in live-capable buy paths.

## Risk Gate

The risk gate approves or rejects candidates using policy and broker-reconciled portfolio state. It returns reason codes and warnings, and never submits orders.

## Trading Loop

The trading loop orchestrates signal processing. It validates input, enforces broker reconciliation where available, calls the risk gate, calls the execution adapter, writes audit/performance events, and returns an explainable result.

## Alpaca Adapter

The Alpaca adapter fetches account state, positions, open orders, submits orders, looks up orders, and normalizes broker responses. It never makes strategy decisions.

## Accounting And Performance

Accounting and performance modules record outcomes, compute metrics, and preserve decision history. They must not override Alpaca truth.

## Dashboard

The dashboard displays state, warnings, broker/local mismatches, and process health. It must not add manual buy, sell, or liquidate controls.

## Process Controller

The process controller starts and stops local services, manages local process locks, and reports local authority. It does not make strategy or broker-order decisions.
