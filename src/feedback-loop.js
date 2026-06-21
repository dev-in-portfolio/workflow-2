const fs = require('fs');
const path = require('path');
const { computePaperOutcome } = require('./paper-outcomes');
const { calculateDrawdown, generateDailyLiveResultsReport, summarizeFillQuality } = require('./metrics');
const { buildThresholdProposal } = require('./performance-tuning');
const { nowIso, safeNumber } = require('./util');

class PerformanceStore {
  constructor(options = {}) {
    this.historyPath = options.historyPath || null;
    this.policyPath = options.policyPath || null;
    this.policyHistoryPath = options.policyHistoryPath || null;
    this.startupPolicyPatch = options.startupPolicyPatch || null;
    this.signals = [];
    this.riskDecisions = [];
    this.paperOutcomes = [];
    this.events = [];
    this.policySnapshot = null;
    this.policyHistory = [];
    if (this.historyPath) {
      this.loadHistoryFromDisk(this.historyPath);
    }
    if (this.policyHistoryPath) {
      this.loadPolicyHistoryFromDisk(this.policyHistoryPath);
    }
    if (this.policyPath) {
      this.loadPolicyFromDisk(this.policyPath);
    }
    if (this.startupPolicyPatch) {
      const mergedSnapshot = mergePolicySnapshot(this.policySnapshot || defaultPolicySnapshot(), this.startupPolicyPatch);
      this.policySnapshot = normalizePolicySnapshot(mergedSnapshot);
      this.policyHistory.push(this.policySnapshot);
      if (this.policyPath) {
        this.writePolicySnapshotToDisk(this.policyPath, this.policySnapshot);
      }
      this.appendPolicyHistoryRecord(this.policySnapshot);
    } else if (!this.policySnapshot && options.initialPolicySnapshot) {
      this.policySnapshot = normalizePolicySnapshot(options.initialPolicySnapshot);
      this.policyHistory.push(this.policySnapshot);
    }
  }

  recordSignal(signal) {
    const record = {
      ...signal,
      recorded_at: signal.recorded_at || nowIso(),
    };
    this.signals.push(record);
    this.appendHistoryRecord('signal', record);
    return record;
  }

  recordRiskDecision(decision) {
    const record = {
      ...decision,
      recorded_at: decision.recorded_at || nowIso(),
    };
    this.riskDecisions.push(record);
    this.appendHistoryRecord('risk_decision', record);
    return record;
  }

  recordPaperOutcome(outcome) {
    const recordedAt = normalizeOutcomeTimestamp(outcome);
    const record = {
      ...outcome,
      recorded_at: recordedAt,
    };
    this.paperOutcomes.push(record);
    this.appendHistoryRecord('paper_outcome', record);
    return record;
  }

  exportReplayFixtures({
    dateFrom = null,
    dateTo = null,
    limit = 1000,
  } = {}) {
    const signalsById = new Map(this.signals.map((signal) => [signal.signal_id, signal]));
    const outcomes = this.paperOutcomes.filter((outcome) => withinRange(outcome.recorded_at || outcome.created_at || outcome.paper_result?.filled_at || null, dateFrom, dateTo));
    const fixtures = [];

    for (const outcome of outcomes.slice(-limit)) {
      const signal = signalsById.get(outcome.signal_id) || outcome.original_signal || null;
      const signalTimestamp = signal?.created_at || signal?.recorded_at || outcome.recorded_at || nowIso();
      const marketPrice = safeNumber(outcome.paper_result?.entry_price ?? outcome.entry_price ?? outcome.paper_result?.price ?? outcome.price ?? null);
      const marketData = {
        provider: signal?.provider_name || signal?.provider || 'paper-history',
        symbol: signal?.symbol || outcome.symbol || null,
        asset_type: signal?.asset_type || 'stock',
        kind: 'quote',
        timestamp: signalTimestamp,
        received_at: outcome.paper_result?.filled_at || outcome.recorded_at || signalTimestamp,
        price: Number.isFinite(marketPrice) ? marketPrice : safeNumber(signal?.entry_price ?? signal?.price ?? null),
        volume: safeNumber(signal?.volume ?? null),
        confidence: safeNumber(signal?.confidence_score ?? null),
        reliability: safeNumber(signal?.source_quality_score ?? null),
      };

      if (!marketData.symbol) continue;

      fixtures.push({
        market_data: marketData,
        signal: normalizeSignalForReplay(signal, outcome, signalTimestamp),
        portfolio: {
          trade_count_today: safeNumber(signal?.trade_count_today ?? 0),
          daily_loss: safeNumber(signal?.daily_loss ?? 0),
          position_notional: safeNumber(signal?.position_notional ?? 0),
          available: signal?.portfolio_available ?? true,
        },
        market_context: {
          market_closed: false,
          volatility_pct: safeNumber(signal?.volatility_pct ?? null),
          spread_slippage_pct: safeNumber(signal?.spread_slippage_pct ?? null),
          volume: safeNumber(signal?.volume ?? null),
        },
        paper_outcome: outcome,
      });
    }

    return fixtures;
  }

  recordPaperExecution({ original_signal, paper_result, entry_price, exit_price, high_price, low_price, quantity, side, false_positive }) {
    const storedSignal = original_signal?.signal_id ? this.signals.find((signal) => signal.signal_id === original_signal.signal_id) : null;
    const filledAt = paper_result?.filled_at
      || paper_result?.filledAt
      || original_signal?.filled_at
      || original_signal?.filledAt
      || storedSignal?.created_at
      || storedSignal?.recorded_at
      || nowIso();
    const outcome = computePaperOutcome({
      original_signal,
      paper_result: {
        ...paper_result,
        filled_at: filledAt,
      },
      entry_price,
      exit_price,
      high_price,
      low_price,
      quantity,
      side,
      false_positive,
      estimated_entry_price: safeNumber(paper_result?.estimated_entry_price ?? paper_result?.average_fill_price ?? paper_result?.entry_price ?? null),
      estimated_exit_price: safeNumber(paper_result?.estimated_exit_price ?? paper_result?.exit_price ?? null),
      estimated_fees: safeNumber(paper_result?.estimated_fees ?? paper_result?.fees ?? null),
    });
    return this.recordPaperOutcome({
      ...outcome,
      recorded_at: filledAt,
      signal_id: original_signal?.signal_id || paper_result?.signal_id || null,
      symbol: original_signal?.symbol || paper_result?.symbol || null,
    });
  }

  recordEvent(event) {
    const record = {
      ...event,
      created_at: event.created_at || nowIso(),
    };
    this.events.push(record);
    this.appendHistoryRecord('event', record);
    return record;
  }

  getPolicySnapshot() {
    return this.policySnapshot || defaultPolicySnapshot();
  }

  setPolicySnapshot(snapshot) {
    const record = normalizePolicySnapshot(snapshot);
    this.policySnapshot = record;
    this.policyHistory.push(record);
    if (this.policyPath) {
      this.writePolicySnapshotToDisk(this.policyPath, record);
    }
    this.appendPolicyHistoryRecord(record);
    return record;
  }

  loadPolicyFromDisk(policyPath) {
    if (!policyPath || !fs.existsSync(policyPath)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
      this.policySnapshot = normalizePolicySnapshot(raw);
      return this.policySnapshot;
    } catch {
      return null;
    }
  }

  loadPolicyHistoryFromDisk(policyHistoryPath) {
    if (!policyHistoryPath || !fs.existsSync(policyHistoryPath)) return;
    const lines = fs.readFileSync(policyHistoryPath, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      this.policyHistory.push(normalizePolicySnapshot(entry));
    }
    if (!this.policySnapshot && this.policyHistory.length) {
      this.policySnapshot = this.policyHistory[this.policyHistory.length - 1];
    }
  }

  writePolicySnapshotToDisk(policyPath, snapshot) {
    if (!policyPath) return;
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.writeFileSync(policyPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  }

  appendPolicyHistoryRecord(snapshot) {
    if (!this.policyHistoryPath) return;
    fs.mkdirSync(path.dirname(this.policyHistoryPath), { recursive: true });
    fs.appendFileSync(this.policyHistoryPath, `${JSON.stringify(snapshot)}\n`, 'utf8');
  }

  loadHistoryFromDisk(historyPath) {
    if (!historyPath || !fs.existsSync(historyPath)) return;
    const lines = fs.readFileSync(historyPath, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const normalized = normalizeHistoryEntry(entry);
      if (!normalized) continue;
      if (normalized.entry_type === 'signal') this.signals.push(normalized.record);
      if (normalized.entry_type === 'risk_decision') this.riskDecisions.push(normalized.record);
      if (normalized.entry_type === 'paper_outcome') this.paperOutcomes.push(normalized.record);
      if (normalized.entry_type === 'event') this.events.push(normalized.record);
    }
  }

  appendHistoryRecord(entryType, record) {
    if (!this.historyPath) return;
    fs.mkdirSync(path.dirname(this.historyPath), { recursive: true });
    const payload = JSON.stringify({
      entry_type: entryType,
      record,
    });
    fs.appendFileSync(this.historyPath, `${payload}\n`, 'utf8');
  }

  getDailyReport(date) {
    const summaryDate = date || this.getLatestActivityDate() || nowIso().slice(0, 10);
    const relevantSignals = this.signals.filter((signal) => (signal.created_at || signal.recorded_at || '').slice(0, 10) === summaryDate);
    const relevantDecisions = this.riskDecisions.filter((decision) => (decision.timestamp || decision.recorded_at || '').slice(0, 10) === summaryDate);
    const relevantOutcomes = this.paperOutcomes.filter((outcome) => (outcome.recorded_at || '').slice(0, 10) === summaryDate);
    const report = generateDailyLiveResultsReport({
      date: summaryDate,
      signals: relevantSignals,
      riskDecisions: relevantDecisions,
      paperOutcomes: relevantOutcomes,
      events: this.events.filter((event) => (event.created_at || '').slice(0, 10) === summaryDate),
      policySnapshot: this.getPolicySnapshot(),
    });
    return {
      ...report,
      policy_snapshot: this.getPolicySnapshot(),
    };
  }

  getPolicyHistory() {
    if (this.policyHistory.length) return this.policyHistory.slice();
    return [this.getPolicySnapshot()];
  }

  getPolicyEffectiveness({ dateFrom = null, dateTo = null, limit = 20 } = {}) {
    const snapshots = this.getPolicyHistory().slice(-limit).sort((a, b) => new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime());
    const intervals = snapshots.map((snapshot, index) => {
      const start = snapshot.captured_at || null;
      const end = snapshots[index + 1]?.captured_at || dateTo || nowIso();
      const outcomeTimestamp = (outcome) => outcome.paper_result?.filled_at || outcome.recorded_at || outcome.created_at || null;
      const relevantOutcomes = this.paperOutcomes.filter((outcome) => withinRange(outcomeTimestamp(outcome), start, end) && withinRange(outcomeTimestamp(outcome), dateFrom, dateTo));
      const relevantSignals = this.signals.filter((signal) => withinRange(signal.created_at || signal.recorded_at || null, start, end) && withinRange(signal.created_at || signal.recorded_at || null, dateFrom, dateTo));
      const relevantDecisions = this.riskDecisions.filter((decision) => withinRange(decision.timestamp || decision.recorded_at || null, start, end) && withinRange(decision.timestamp || decision.recorded_at || null, dateFrom, dateTo));
      const paperPnl = relevantOutcomes.reduce((sum, outcome) => sum + safeNumber(outcome.pnl, 0), 0);
      const wins = relevantOutcomes.filter((outcome) => outcome.win_loss === 'win').length;
      const losses = relevantOutcomes.filter((outcome) => outcome.win_loss === 'loss').length;
      const executionDrag = relevantOutcomes.reduce((sum, outcome) => sum + safeNumber(outcome.execution_drag ?? 0, 0), 0);
      const fillQualitySummary = summarizeFillQuality(relevantOutcomes);
      const recommendedPositionSizeMultiplier = recommendPositionSizeMultiplier({
        paperPnl,
        winRate: relevantOutcomes.length ? wins / relevantOutcomes.length : 0,
        blockedRate: relevantDecisions.length ? relevantDecisions.filter((decision) => decision.decision === 'BLOCKED').length / relevantDecisions.length : 0,
        falsePositives: relevantOutcomes.filter((outcome) => outcome.false_positive).length,
        executionDrag,
        fillRate: fillQualitySummary.fill_rate,
        partialFillRate: fillQualitySummary.partial_fill_rate,
        drawdown: calculateDrawdown(relevantOutcomes),
      });
      const recommendedMaxOpenPositions = recommendOpenPositionCap({
        currentMaxOpenPositions: snapshot.policy?.maxOpenPositions ?? 12,
        paperPnl,
        winRate: relevantOutcomes.length ? wins / relevantOutcomes.length : 0,
        blockedRate: relevantDecisions.length ? relevantDecisions.filter((decision) => decision.decision === 'BLOCKED').length / relevantDecisions.length : 0,
        falsePositives: relevantOutcomes.filter((outcome) => outcome.false_positive).length,
        executionDrag,
        fillRate: fillQualitySummary.fill_rate,
        partialFillRate: fillQualitySummary.partial_fill_rate,
        rejectionRate: fillQualitySummary.rejection_rate,
        drawdown: calculateDrawdown(relevantOutcomes),
      });
      return {
        captured_at: snapshot.captured_at,
        report_date: snapshot.report_date,
        policy: snapshot.policy,
        reason_codes: snapshot.reason_codes,
        signal_count: relevantSignals.length,
        blocked_count: relevantDecisions.filter((decision) => decision.decision === 'BLOCKED').length,
        approved_count: relevantDecisions.filter((decision) => decision.decision === 'APPROVED_FOR_PAPER').length,
        paper_outcome_count: relevantOutcomes.length,
        paper_pnl: paperPnl,
        win_rate: relevantOutcomes.length ? wins / relevantOutcomes.length : 0,
        false_positives: relevantOutcomes.filter((outcome) => outcome.false_positive).length,
        execution_drag: executionDrag,
        fill_rate: fillQualitySummary.fill_rate,
        partial_fill_rate: fillQualitySummary.partial_fill_rate,
        rejection_rate: fillQualitySummary.rejection_rate,
        wins,
        losses,
        max_drawdown: calculateDrawdown(relevantOutcomes),
        recommended_position_size_multiplier: recommendedPositionSizeMultiplier,
        recommended_max_open_positions: recommendedMaxOpenPositions,
      };
    });

    const scoredIntervals = intervals.map((interval) => ({
      ...interval,
      durability_score: scorePolicyInterval(interval),
    }));
    const bestPolicy = scoredIntervals.slice().sort((a, b) => b.durability_score - a.durability_score || b.paper_pnl - a.paper_pnl)[0] || null;
    const worstPolicy = scoredIntervals.slice().sort((a, b) => a.durability_score - b.durability_score || a.paper_pnl - b.paper_pnl)[0] || null;
    return {
      interval_count: scoredIntervals.length,
      best_policy: bestPolicy,
      worst_policy: worstPolicy,
      recommended_position_size_multiplier: bestPolicy?.recommended_position_size_multiplier ?? 1,
      recommended_max_open_positions: bestPolicy?.recommended_max_open_positions ?? this.getPolicySnapshot().policy?.maxOpenPositions ?? 12,
      intervals: scoredIntervals,
    };
  }

  rollbackToBestPolicy({ dateFrom = null, dateTo = null, limit = 20 } = {}) {
    const effectiveness = this.getPolicyEffectiveness({ dateFrom, dateTo, limit });
    if (!effectiveness.best_policy) {
      return {
        accepted: false,
        reason: 'NO_POLICY_HISTORY',
        policy_snapshot: this.getPolicySnapshot(),
        policy_effectiveness: effectiveness,
      };
    }

    const rollbackSnapshot = this.setPolicySnapshot({
      source: 'rollback',
      captured_at: nowIso(),
      report_date: effectiveness.best_policy.report_date || nowIso().slice(0, 10),
      reason_codes: [...(effectiveness.best_policy.reason_codes || []), 'AUTO_ROLLBACK_TO_BEST_POLICY'],
      policy: effectiveness.best_policy.policy,
      rollback_from: this.getPolicySnapshot(),
      rollback_reason: 'best historical performance',
    });

    return {
      accepted: true,
      policy_snapshot: rollbackSnapshot,
      policy_effectiveness: effectiveness,
    };
  }

  rebalancePolicySize({ dateFrom = null, dateTo = null, limit = 20 } = {}) {
    const effectiveness = this.getPolicyEffectiveness({ dateFrom, dateTo, limit });
    const recommendedMultiplier = effectiveness.recommended_position_size_multiplier ?? 1;
    const currentSnapshot = this.getPolicySnapshot();
    const currentMultiplier = safeNumber(currentSnapshot.policy?.positionSizeMultiplier, 1);
    if (Math.abs(recommendedMultiplier - currentMultiplier) < 0.01) {
      return {
        accepted: false,
        reason: 'NO_SIZE_CHANGE_NEEDED',
        policy_snapshot: currentSnapshot,
        policy_effectiveness: effectiveness,
      };
    }

    const rebalanceSnapshot = this.setPolicySnapshot({
      source: 'size-rebalance',
      captured_at: nowIso(),
      report_date: effectiveness.best_policy?.report_date || nowIso().slice(0, 10),
      reason_codes: ['AUTO_SIZE_REBALANCE'],
      policy: {
        ...currentSnapshot.policy,
        positionSizeMultiplier: recommendedMultiplier,
      },
      previous_policy_snapshot: currentSnapshot,
      rebalance_reason: 'policy effectiveness recommendation',
      policy_effectiveness: effectiveness,
    });

    return {
      accepted: true,
      policy_snapshot: rebalanceSnapshot,
      policy_effectiveness: effectiveness,
    };
  }

  rebalancePolicyCapacity({ dateFrom = null, dateTo = null, limit = 20 } = {}) {
    const effectiveness = this.getPolicyEffectiveness({ dateFrom, dateTo, limit });
    const recommendedMaxOpenPositions = Math.max(1, Math.round(safeNumber(effectiveness.recommended_max_open_positions, 12)));
    const currentSnapshot = this.getPolicySnapshot();
    const currentMaxOpenPositions = Math.max(1, Math.round(safeNumber(currentSnapshot.policy?.maxOpenPositions, 12)));
    if (recommendedMaxOpenPositions === currentMaxOpenPositions) {
      return {
        accepted: false,
        reason: 'NO_CAPACITY_CHANGE_NEEDED',
        policy_snapshot: currentSnapshot,
        policy_effectiveness: effectiveness,
      };
    }

    const capacitySnapshot = this.setPolicySnapshot({
      source: 'capacity-rebalance',
      captured_at: nowIso(),
      report_date: effectiveness.best_policy?.report_date || nowIso().slice(0, 10),
      reason_codes: ['AUTO_CAPACITY_REBALANCE'],
      policy: {
        ...currentSnapshot.policy,
        maxOpenPositions: recommendedMaxOpenPositions,
      },
      previous_policy_snapshot: currentSnapshot,
      rebalance_reason: 'policy effectiveness recommendation',
      policy_effectiveness: effectiveness,
    });

    return {
      accepted: true,
      policy_snapshot: capacitySnapshot,
      policy_effectiveness: effectiveness,
    };
  }

  getCalibrationByBucket() {
    const buckets = new Map();
    for (const outcome of this.paperOutcomes) {
      const bucket = outcome.calibration_bucket || 'unknown';
      const current = buckets.get(bucket) || { bucket, count: 0, wins: 0, losses: 0, total_pnl: 0 };
      current.count += 1;
      current.total_pnl += safeNumber(outcome.pnl, 0);
      if (outcome.win_loss === 'win') current.wins += 1;
      if (outcome.win_loss === 'loss') current.losses += 1;
      buckets.set(bucket, current);
    }
    return [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
  }

  suggestTuning() {
    const report = this.getDailyReport();
    const bucketStats = this.getCalibrationByBucket();
    const suggestions = [...report.recommended_tuning_notes];
    const effectiveness = this.getPolicyEffectiveness();
    const currentMaxOpenPositions = Math.max(1, Math.round(safeNumber(this.getPolicySnapshot().policy?.maxOpenPositions, 12)));
    if (effectiveness.recommended_max_open_positions > currentMaxOpenPositions) {
      suggestions.push(`Recent performance supports raising maxOpenPositions from ${currentMaxOpenPositions} to ${effectiveness.recommended_max_open_positions}.`);
    } else if (effectiveness.recommended_max_open_positions < currentMaxOpenPositions) {
      suggestions.push(`Recent performance suggests reducing maxOpenPositions from ${currentMaxOpenPositions} to ${effectiveness.recommended_max_open_positions}.`);
    }
    const lowWinBuckets = bucketStats.filter((bucket) => bucket.count >= 3 && bucket.wins / bucket.count < 0.5);
    if (lowWinBuckets.length) {
      suggestions.push(`Consider lowering confidence on buckets: ${lowWinBuckets.map((bucket) => bucket.bucket).join(', ')}.`);
    }
    if (report.false_positives > 0 && report.paper_pnl < 0) {
      suggestions.push('False positives are costing PnL; tighten contradiction and freshness thresholds.');
    }
    if (report.dominant_block_reason?.reason === 'MAX_OPEN_POSITIONS_EXCEEDED') {
      suggestions.push('Open positions are the main bottleneck; widen maxOpenPositions only if the PnL and drawdown profile stays healthy.');
    }
    if (report.dominant_block_reason?.reason === 'STALE_DATA' || report.dominant_block_reason?.reason === 'INVALID_TIMESTAMP') {
      suggestions.push('Stale or invalid provider timestamps are the main bottleneck; prioritize fresher feeds before widening size or concurrency.');
    }
    if (report.dominant_block_reason?.reason === 'MULTI_SOURCE_CONFIRMATION_FAILED') {
      suggestions.push('Provider disagreement is the main bottleneck; tighten Alpaca and Twelve Data confirmation before increasing activity.');
    }
    const thresholdProposal = buildThresholdProposal({
      currentPolicy: this.getPolicySnapshot().policy,
      signals: this.signals,
      paperOutcomes: this.paperOutcomes,
      riskDecisions: this.riskDecisions,
    });
    return {
      report,
      calibration_buckets: bucketStats,
      suggestions,
      threshold_proposal: thresholdProposal,
      policy_snapshot: this.getPolicySnapshot(),
      policy_effectiveness: this.getPolicyEffectiveness(),
    };
  }

  refreshPolicyFromLearning({ source = 'learning-refresh', reportDate = null } = {}) {
    const tuning = this.suggestTuning();
    return this.setPolicySnapshot({
      source,
      captured_at: nowIso(),
      report_date: reportDate || tuning.report.date,
      reason_codes: [
        ...(tuning.threshold_proposal.reason_codes || []),
        ...(tuning.report.dominant_block_reason?.reason ? [`DOMINANT_BLOCK_${tuning.report.dominant_block_reason.reason}`] : []),
        ...(tuning.report.rejection_pressure_score >= 60 ? ['HIGH_REJECTION_PRESSURE'] : []),
      ],
      policy: tuning.threshold_proposal.proposed_policy,
      tuning_notes: tuning.suggestions,
      calibration_buckets: tuning.calibration_buckets,
      learning_report: tuning.report,
    });
  }

  getLatestActivityDate() {
    const timestamps = [
      ...this.signals.map((item) => item.created_at || item.recorded_at || null),
      ...this.riskDecisions.map((item) => item.timestamp || item.recorded_at || null),
      ...this.paperOutcomes.map((item) => item.recorded_at || item.paper_result?.filled_at || null),
      ...this.events.map((item) => item.created_at || null),
    ].filter(Boolean);
    if (!timestamps.length) return null;
    const latest = timestamps
      .map((value) => new Date(value))
      .filter((date) => !Number.isNaN(date.getTime()))
      .sort((a, b) => b.getTime() - a.getTime())[0];
    return latest ? latest.toISOString().slice(0, 10) : null;
  }
}

function recommendPositionSizeMultiplier({ paperPnl = 0, winRate = 0, blockedRate = 0, falsePositives = 0, drawdown = 0, executionDrag = 0, fillRate = 0, partialFillRate = 0 } = {}) {
  let multiplier = 1;
  if (paperPnl > 0 && winRate >= 0.55) {
    multiplier += 0.1;
  }
  if (paperPnl > 0 && winRate >= 0.7 && blockedRate < 0.3 && falsePositives === 0 && drawdown === 0) {
    multiplier += 0.1;
  }
  if (paperPnl > 0 && winRate >= 0.8 && falsePositives === 0) {
    multiplier += 0.05;
  }
  if (paperPnl < 0 || blockedRate > 0.6 || falsePositives > 0) {
    multiplier -= 0.15;
  }
  if (executionDrag > 0) {
    multiplier -= executionDrag >= Math.max(10, Math.abs(paperPnl) * 0.5) ? 0.12 : 0.05;
  }
  if (fillRate > 0 && fillRate < 0.8) {
    multiplier -= 0.05;
  }
  if (partialFillRate > 0.1) {
    multiplier -= 0.08;
  }
  if (drawdown > 0) {
    multiplier -= drawdown >= Math.max(10, Math.abs(paperPnl) * 0.5) ? 0.15 : 0.05;
  }
  if (winRate >= 0.7 && falsePositives === 0) {
    multiplier += 0.05;
  }
  return Number(Math.max(0.5, Math.min(1.35, multiplier)).toFixed(2));
}

function recommendOpenPositionCap({
  currentMaxOpenPositions = 12,
  paperPnl = 0,
  winRate = 0,
  blockedRate = 0,
  falsePositives = 0,
  drawdown = 0,
  executionDrag = 0,
  fillRate = 0,
  partialFillRate = 0,
  rejectionRate = 0,
} = {}) {
  let cap = Math.max(1, Math.round(safeNumber(currentMaxOpenPositions, 12)));
  const healthyRun = paperPnl > 0 && winRate >= 0.6 && drawdown <= Math.max(5, Math.abs(paperPnl) * 0.4) && falsePositives === 0;
  const excellentRun = healthyRun && paperPnl > 25 && winRate >= 0.7 && fillRate >= 0.9 && partialFillRate <= 0.03 && rejectionRate <= 0.03;
  if (healthyRun) {
    cap += 1;
  }
  if (excellentRun) {
    cap += 1;
  }
  if (blockedRate > 0.6 || falsePositives > 0 || drawdown > Math.max(10, Math.abs(paperPnl) * 0.5)) {
    cap -= 1;
  }
  if (executionDrag > Math.max(10, Math.abs(paperPnl) * 0.5)) {
    cap -= 1;
  }
  if (fillRate > 0 && fillRate < 0.8) {
    cap -= 1;
  }
  if (partialFillRate > 0.1 || rejectionRate > 0.1) {
    cap -= 1;
  }
  return clampInt(cap, 1, 15);
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function scorePolicyInterval(interval = {}) {
  const paperPnl = safeNumber(interval.paper_pnl, 0);
  const drawdown = safeNumber(interval.max_drawdown, 0);
  const falsePositives = safeNumber(interval.false_positives, 0);
  const executionDrag = safeNumber(interval.execution_drag, 0);
  const fillRate = safeNumber(interval.fill_rate, 0);
  const partialFillRate = safeNumber(interval.partial_fill_rate, 0);
  const blockedCount = safeNumber(interval.blocked_count, 0);
  const winRate = safeNumber(interval.win_rate, 0);
  const approvedCount = safeNumber(interval.approved_count, 0);
  const signalCount = Math.max(1, safeNumber(interval.signal_count, 0));
  const approvalRate = approvedCount / signalCount;
  return paperPnl - (drawdown * 1.25) - (falsePositives * 1.5) - (executionDrag * 1.1) - (partialFillRate * 10) - ((1 - fillRate) * 5) - (blockedCount * 0.2) + (winRate * 5) + (approvalRate * 3);
}

function defaultPolicySnapshot() {
  return normalizePolicySnapshot({
    source: 'default',
    captured_at: nowIso(),
    policy: {
      killSwitch: false,
      paperAdapterEnabled: true,
      requireHumanApproval: true,
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minCryptoProviderConfirmationScore: 35,
      minSellProviderConfirmationScore: 60,
      sellMaxProviderPriceDiffPct: 0.75,
      minEdgeScore: 60,
      blockedCalibrationBuckets: [],
      maxContradictionScore: 50,
      maxRiskScore: 70,
      minLiquidityScore: 40,
      minVolume: 1000,
      maxOpenPositions: 12,
      positionSizeMultiplier: 1,
      sellProfitThresholdPct: 5,
      sellNetProfitFloorDollars: 1,
      blockedBuyCalibrationBuckets: [],
      blockBuys: false,
    },
    reason_codes: ['DEFAULT_POLICY'],
    report_date: nowIso().slice(0, 10),
  });
}

function normalizePolicySnapshot(snapshot) {
  const policy = snapshot?.policy || snapshot?.proposed_policy || snapshot || {};
  return {
    source: snapshot?.source || 'manual',
    captured_at: snapshot?.captured_at || nowIso(),
    report_date: snapshot?.report_date || snapshot?.date || nowIso().slice(0, 10),
    reason_codes: Array.isArray(snapshot?.reason_codes) ? snapshot.reason_codes : [],
    policy: {
      killSwitch: Boolean(policy.killSwitch ?? false),
      paperAdapterEnabled: Boolean(policy.paperAdapterEnabled ?? true),
      requireHumanApproval: policy.requireHumanApproval ?? true,
      minConfidenceForPaper: safeNumber(policy.minConfidenceForPaper ?? 72, 72),
      minFreshnessScore: safeNumber(policy.minFreshnessScore ?? 55, 55),
      minSourceQualityScore: safeNumber(policy.minSourceQualityScore ?? 40, 40),
      minProviderConfirmationScore: safeNumber(policy.minProviderConfirmationScore ?? 70, 70),
      minCryptoProviderConfirmationScore: safeNumber(policy.minCryptoProviderConfirmationScore ?? 35, 35),
      minSellProviderConfirmationScore: safeNumber(policy.minSellProviderConfirmationScore ?? 60, 60),
      sellMaxProviderPriceDiffPct: safeNumber(policy.sellMaxProviderPriceDiffPct ?? 0.75, 0.75),
      minEdgeScore: safeNumber(policy.minEdgeScore ?? 60, 60),
      blockedCalibrationBuckets: Array.isArray(policy.blockedCalibrationBuckets) ? policy.blockedCalibrationBuckets.slice() : [],
      maxContradictionScore: safeNumber(policy.maxContradictionScore ?? 50, 50),
      maxRiskScore: safeNumber(policy.maxRiskScore ?? 70, 70),
      minLiquidityScore: safeNumber(policy.minLiquidityScore ?? 40, 40),
      minVolume: safeNumber(policy.minVolume ?? 1000, 1000),
      maxOpenPositions: Math.max(1, Math.round(safeNumber(policy.maxOpenPositions ?? 12, 12))),
      positionSizeMultiplier: safeNumber(policy.positionSizeMultiplier ?? 1, 1),
      sellProfitThresholdPct: safeNumber(policy.sellProfitThresholdPct ?? 5, 5),
      sellNetProfitFloorDollars: safeNumber(policy.sellNetProfitFloorDollars ?? 1, 1),
      buyNotionalTarget: safeNumber(policy.buyNotionalTarget ?? 150, 150),
      volatilityThresholdPct: safeNumber(policy.volatilityThresholdPct ?? 6, 6),
      blockedBuyCalibrationBuckets: Array.isArray(policy.blockedBuyCalibrationBuckets) ? policy.blockedBuyCalibrationBuckets.slice() : [],
      blockBuys: Boolean(policy.blockBuys ?? false),
    },
  };
}

function mergePolicySnapshot(snapshot, patch = {}) {
  const normalized = normalizePolicySnapshot(snapshot);
  const patchPolicy = patch.policy || patch.proposed_policy || patch;
  return {
    ...normalized,
    ...patch,
    policy: {
      ...normalized.policy,
      ...patchPolicy,
    },
  };
}

function normalizeSignalForReplay(signal, outcome, timestamp) {
  if (!signal && !outcome) return null;
  const base = signal || {};
  return {
    signal_id: base.signal_id || outcome.signal_id || null,
    symbol: base.symbol || outcome.symbol || null,
    asset_type: base.asset_type || 'stock',
    strategy_name: base.strategy_name || 'unknown',
    timeframe: base.timeframe || 'unknown',
    direction: base.direction || 'neutral',
    stop_loss: safeNumber(base.stop_loss ?? outcome.paper_result?.stop_loss ?? null),
    take_profit: safeNumber(base.take_profit ?? outcome.paper_result?.take_profit ?? null),
    entry_price: safeNumber(base.entry_price ?? outcome.paper_result?.entry_price ?? null),
    confidence_score: safeNumber(base.confidence_score ?? null),
    freshness_score: safeNumber(base.freshness_score ?? null),
    source_quality_score: safeNumber(base.source_quality_score ?? null),
    contradiction_score: safeNumber(base.contradiction_score ?? null),
    risk_score: safeNumber(base.risk_score ?? null),
    edge_score: safeNumber(base.edge_score ?? null),
    provider_confirmation_score: safeNumber(base.provider_confirmation_score ?? null),
    liquidity_score: safeNumber(base.liquidity_score ?? null),
    volume: safeNumber(base.volume ?? null),
    created_at: base.created_at || timestamp,
    recorded_at: base.recorded_at || timestamp,
    provider_name: base.provider_name || 'paper-history',
    evidence: base.evidence || [],
    market_context: base.market_context || base.marketContext || null,
  };
}

function normalizeOutcomeTimestamp(outcome = {}) {
  return outcome.recorded_at
    || outcome.paper_result?.filled_at
    || outcome.paper_result?.filledAt
    || outcome.paper_result?.updated_at
    || outcome.paper_result?.created_at
    || outcome.created_at
    || nowIso();
}

function normalizeHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.entry_type && entry.record) {
    return {
      entry_type: entry.entry_type,
      record: entry.record,
    };
  }
  if (entry.kind && entry.payload) {
    return {
      entry_type: entry.kind,
      record: entry.payload,
    };
  }
  if (entry.signal_id || entry.decision || entry.event_type) {
    return {
      entry_type: inferHistoryEntryType(entry),
      record: entry,
    };
  }
  return null;
}

function inferHistoryEntryType(entry) {
  if (entry.event_type) return 'event';
  if (entry.decision || entry.reason_codes) return 'risk_decision';
  if (entry.calibration_bucket || entry.pnl !== undefined || entry.paper_result) return 'paper_outcome';
  return 'signal';
}

function withinRange(value, from, to) {
  if (!value) return true;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return true;
  if (from) {
    const fromTime = new Date(from).getTime();
    if (!Number.isNaN(fromTime) && time < fromTime) return false;
  }
  if (to) {
    const toTime = new Date(to).getTime();
    if (!Number.isNaN(toTime) && time > toTime) return false;
  }
  return true;
}

module.exports = {
  PerformanceStore,
  defaultPolicySnapshot,
  normalizePolicySnapshot,
  mergePolicySnapshot,
  recommendPositionSizeMultiplier,
  recommendOpenPositionCap,
  scorePolicyInterval,
};
