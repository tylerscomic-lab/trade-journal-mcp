import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import http from 'http';
import { randomUUID } from 'crypto';

const server = new McpServer({ name: 'trade-journal-mcp', version: '1.0.0' });

// ── helpers ────────────────────────────────────────────────────────────────

function calcMetrics(trades) {
  if (!trades || trades.length === 0) return null;

  const winners = trades.filter(t => t.pnl > 0);
  const losers  = trades.filter(t => t.pnl < 0);
  const flat    = trades.filter(t => t.pnl === 0);

  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss   = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));
  const netPnl      = trades.reduce((s, t) => s + t.pnl, 0);

  const winRate      = trades.length > 0 ? winners.length / trades.length : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const avgWin       = winners.length > 0 ? grossProfit / winners.length : 0;
  const avgLoss      = losers.length > 0 ? -grossLoss / losers.length : 0;
  const rr           = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : null;

  // max drawdown (peak-to-trough on running equity)
  let peak = 0, runningPnl = 0, maxDD = 0;
  for (const t of trades) {
    runningPnl += t.pnl;
    if (runningPnl > peak) peak = runningPnl;
    const dd = peak - runningPnl;
    if (dd > maxDD) maxDD = dd;
  }

  // consecutive wins/losses
  let maxConsecWins = 0, maxConsecLosses = 0, curW = 0, curL = 0;
  for (const t of trades) {
    if (t.pnl > 0) { curW++; curL = 0; if (curW > maxConsecWins) maxConsecWins = curW; }
    else if (t.pnl < 0) { curL++; curW = 0; if (curL > maxConsecLosses) maxConsecLosses = curL; }
    else { curW = 0; curL = 0; }
  }

  // best / worst day grouping
  const dayMap = {};
  for (const t of trades) {
    const day = t.date ? t.date.slice(0, 10) : 'unknown';
    dayMap[day] = (dayMap[day] || 0) + t.pnl;
  }
  const dayPnls = Object.values(dayMap);
  const bestDay  = dayPnls.length ? Math.max(...dayPnls) : 0;
  const worstDay = dayPnls.length ? Math.min(...dayPnls) : 0;

  // consistency score: stddev of daily pnl
  let consistencyScore = null;
  if (dayPnls.length > 1) {
    const mean = dayPnls.reduce((s, v) => s + v, 0) / dayPnls.length;
    const variance = dayPnls.reduce((s, v) => s + (v - mean) ** 2, 0) / dayPnls.length;
    const stddev = Math.sqrt(variance);
    // lower stddev relative to mean = more consistent (0–100 scale)
    consistencyScore = mean > 0 ? Math.max(0, Math.min(100, 100 - (stddev / mean) * 50)) : null;
  }

  return {
    totalTrades: trades.length,
    winners: winners.length,
    losers: losers.length,
    flat: flat.length,
    winRate: Math.round(winRate * 10000) / 100,
    grossProfit: Math.round(grossProfit * 100) / 100,
    grossLoss: Math.round(grossLoss * 100) / 100,
    netPnl: Math.round(netPnl * 100) / 100,
    profitFactor: typeof profitFactor === 'number' ? Math.round(profitFactor * 100) / 100 : profitFactor,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    riskRewardRatio: rr !== null ? Math.round(rr * 100) / 100 : null,
    maxDrawdown: Math.round(maxDD * 100) / 100,
    maxConsecWins,
    maxConsecLosses,
    bestDay: Math.round(bestDay * 100) / 100,
    worstDay: Math.round(worstDay * 100) / 100,
    consistencyScore: consistencyScore !== null ? Math.round(consistencyScore * 10) / 10 : null,
    tradingDays: dayPnls.length,
  };
}

function checkViolations(trades, firmRules) {
  const violations = [];
  const warnings   = [];

  if (!firmRules) return { violations, warnings };

  const { dailyLoss, maxDrawdown, consistencyRule, consistencyPct, maxContracts } = firmRules;

  // group by day
  const dayMap = {};
  for (const t of trades) {
    const day = t.date ? t.date.slice(0, 10) : 'unknown';
    if (!dayMap[day]) dayMap[day] = { pnl: 0, maxContracts: {} };
    dayMap[day].pnl += t.pnl;
    if (t.symbol && t.contracts) {
      const prev = dayMap[day].maxContracts[t.symbol] || 0;
      if (t.contracts > prev) dayMap[day].maxContracts[t.symbol] = t.contracts;
    }
  }

  // daily loss check
  if (dailyLoss) {
    for (const [day, data] of Object.entries(dayMap)) {
      if (data.pnl < -dailyLoss) {
        violations.push({ type: 'daily_loss', date: day, amount: Math.round(Math.abs(data.pnl) * 100) / 100, limit: dailyLoss, message: `Daily loss of $${Math.abs(data.pnl).toFixed(2)} exceeded $${dailyLoss} limit on ${day}` });
      } else if (data.pnl < -dailyLoss * 0.8) {
        warnings.push({ type: 'daily_loss_warning', date: day, amount: Math.round(Math.abs(data.pnl) * 100) / 100, limit: dailyLoss, message: `Daily loss approaching limit on ${day} ($${Math.abs(data.pnl).toFixed(2)} of $${dailyLoss})` });
      }
    }
  }

  // max contracts check
  if (maxContracts) {
    for (const [day, data] of Object.entries(dayMap)) {
      for (const [sym, qty] of Object.entries(data.maxContracts)) {
        const symUpper = sym.toUpperCase();
        if (maxContracts[symUpper] && qty > maxContracts[symUpper]) {
          violations.push({ type: 'max_contracts', date: day, symbol: symUpper, traded: qty, limit: maxContracts[symUpper], message: `Traded ${qty} ${symUpper} contracts on ${day}, limit is ${maxContracts[symUpper]}` });
        }
      }
    }
  }

  // consistency rule
  if (consistencyRule && consistencyPct) {
    const netPnl = trades.reduce((s, t) => s + t.pnl, 0);
    if (netPnl > 0) {
      const bestDay = Math.max(...Object.values(dayMap).map(d => d.pnl));
      const bestDayPct = (bestDay / netPnl) * 100;
      if (bestDayPct > consistencyPct) {
        violations.push({ type: 'consistency_rule', bestDay: Math.round(bestDay * 100) / 100, netPnl: Math.round(netPnl * 100) / 100, bestDayPct: Math.round(bestDayPct * 10) / 10, limit: consistencyPct, message: `Best day ($${bestDay.toFixed(2)}) is ${bestDayPct.toFixed(1)}% of net profit — exceeds ${consistencyPct}% consistency rule` });
      }
    }
  }

  return { violations, warnings };
}

const FIRM_RULES_SIMPLE = {
  apex: { dailyLoss: 1500, maxDrawdown: 2500, consistencyRule: true, consistencyPct: 30, maxContracts: { ES: 5, NQ: 3, CL: 3, MES: 50, MNQ: 30 } },
  ftmo: { dailyLoss: 500, maxDrawdown: 1000, consistencyRule: false, maxContracts: {} },
  topstep: { dailyLoss: 1000, maxDrawdown: 2000, consistencyRule: false, maxContracts: { ES: 5, NQ: 3, CL: 3 } },
  bulenox: { dailyLoss: 1500, maxDrawdown: 2500, consistencyRule: true, consistencyPct: 40, maxContracts: { ES: 5, NQ: 3 } },
  myfundedfutures: { dailyLoss: 1500, maxDrawdown: 2500, consistencyRule: true, consistencyPct: 30, maxContracts: { ES: 5, NQ: 3 } },
  tradeday: { dailyLoss: 1500, maxDrawdown: 2500, consistencyRule: false, maxContracts: { ES: 5, NQ: 3 } },
};

// ── tools ──────────────────────────────────────────────────────────────────

server.tool('analyze_trade_history', 'Calculate win rate, profit factor, drawdown, R:R, consistency score, and more from trade data.', {
  trades: z.array(z.object({
    date:      z.string().optional().describe('ISO date string (YYYY-MM-DD or full ISO)'),
    symbol:    z.string().optional().describe('Instrument symbol e.g. ES, NQ, CL'),
    pnl:       z.number().describe('P&L in dollars for this trade'),
    contracts: z.number().optional().describe('Number of contracts traded'),
  })).describe('Array of trades'),
}, async ({ trades }) => {
  const m = calcMetrics(trades);
  if (!m) return { content: [{ type: 'text', text: JSON.stringify({ error: 'No trades provided' }) }] };

  let grade = 'F';
  if (m.profitFactor >= 2 && m.winRate >= 55) grade = 'A';
  else if (m.profitFactor >= 1.5 && m.winRate >= 50) grade = 'B';
  else if (m.profitFactor >= 1.2 && m.winRate >= 45) grade = 'C';
  else if (m.profitFactor >= 1.0) grade = 'D';

  return { content: [{ type: 'text', text: JSON.stringify({ metrics: m, grade, summary: `${m.totalTrades} trades over ${m.tradingDays} days. Win rate: ${m.winRate}%, Profit factor: ${m.profitFactor}, Net P&L: $${m.netPnl}` }) }] };
});

server.tool('calculate_trading_metrics', 'Get specific metrics: Sharpe-like ratio, expectancy, average trade, recovery factor.', {
  trades: z.array(z.object({
    date:      z.string().optional(),
    pnl:       z.number(),
    contracts: z.number().optional(),
  })),
  starting_balance: z.number().optional().describe('Starting account balance for ratio calculations'),
}, async ({ trades, starting_balance }) => {
  if (!trades || trades.length === 0) return { content: [{ type: 'text', text: JSON.stringify({ error: 'No trades' }) }] };

  const m = calcMetrics(trades);
  const netPnl = m.netPnl;
  const avgTrade = netPnl / trades.length;
  const expectancy = (m.winRate / 100) * m.avgWin + (1 - m.winRate / 100) * m.avgLoss;

  // daily pnl for Sharpe calc
  const dayMap = {};
  for (const t of trades) {
    const day = t.date ? t.date.slice(0, 10) : 'unknown';
    dayMap[day] = (dayMap[day] || 0) + t.pnl;
  }
  const dayPnls = Object.values(dayMap);
  let sharpe = null;
  if (dayPnls.length > 1) {
    const mean = dayPnls.reduce((s, v) => s + v, 0) / dayPnls.length;
    const std  = Math.sqrt(dayPnls.reduce((s, v) => s + (v - mean) ** 2, 0) / dayPnls.length);
    sharpe = std > 0 ? Math.round((mean / std) * Math.sqrt(252) * 100) / 100 : null;
  }

  const recoveryFactor = m.maxDrawdown > 0 ? Math.round((netPnl / m.maxDrawdown) * 100) / 100 : null;
  const returnPct = starting_balance ? Math.round((netPnl / starting_balance) * 10000) / 100 : null;

  return {
    content: [{ type: 'text', text: JSON.stringify({
      avgTradePerTrade: Math.round(avgTrade * 100) / 100,
      expectancyPerTrade: Math.round(expectancy * 100) / 100,
      annualizedSharpe: sharpe,
      recoveryFactor,
      returnPct,
      maxDrawdown: m.maxDrawdown,
      profitFactor: m.profitFactor,
      note: sharpe !== null ? `Annualized Sharpe of ${sharpe} — ${sharpe > 2 ? 'excellent' : sharpe > 1 ? 'good' : sharpe > 0 ? 'marginal' : 'poor'}` : 'Need multi-day data for Sharpe',
    }) }],
  };
});

server.tool('check_rule_violations', 'Check a trade history against a specific prop firm\'s rules. Returns violations, warnings, and pass/fail.', {
  trades: z.array(z.object({
    date:      z.string().optional(),
    symbol:    z.string().optional(),
    pnl:       z.number(),
    contracts: z.number().optional(),
  })),
  firm: z.string().describe('Prop firm: apex, ftmo, topstep, bulenox, myfundedfutures, tradeday'),
  account_size: z.number().optional().describe('Account size to scale limits correctly'),
}, async ({ trades, firm, account_size }) => {
  const key = firm.toLowerCase().replace(/[^a-z]/g, '');
  const aliases = { topsteptrader: 'topstep', mff: 'myfundedfutures', 'my-funded-futures': 'myfundedfutures' };
  const firmKey = aliases[key] || key;
  const rules = FIRM_RULES_SIMPLE[firmKey];

  if (!rules) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown firm: ${firm}. Supported: apex, ftmo, topstep, bulenox, myfundedfutures, tradeday` }) }] };
  }

  // scale rules if account_size provided (defaults are for $50k accounts)
  let scaledRules = { ...rules };
  if (account_size && account_size !== 50000) {
    const factor = account_size / 50000;
    scaledRules = { ...rules, dailyLoss: Math.round(rules.dailyLoss * factor), maxDrawdown: Math.round(rules.maxDrawdown * factor) };
  }

  const { violations, warnings } = checkViolations(trades, scaledRules);
  const passed = violations.length === 0;

  return {
    content: [{ type: 'text', text: JSON.stringify({
      firm: firmKey,
      passed,
      violations,
      warnings,
      summary: passed ? `No rule violations found for ${firmKey}${warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? 's' : ''})` : ''}` : `${violations.length} violation${violations.length > 1 ? 's' : ''} found — account at risk`,
    }) }],
  };
});

server.tool('generate_performance_report', 'Generate a comprehensive performance report comparing metrics to prop firm benchmarks.', {
  trades: z.array(z.object({
    date:      z.string().optional(),
    symbol:    z.string().optional(),
    pnl:       z.number(),
    contracts: z.number().optional(),
  })),
  firm: z.string().optional().describe('Prop firm to benchmark against'),
  account_size: z.number().optional().describe('Account size'),
  period_label: z.string().optional().describe('Label for this period e.g. "Week 1" or "January 2025"'),
}, async ({ trades, firm, account_size, period_label }) => {
  if (!trades || trades.length === 0) return { content: [{ type: 'text', text: JSON.stringify({ error: 'No trades' }) }] };

  const m = calcMetrics(trades);
  const label = period_label || 'Period';

  const report = {
    period: label,
    metrics: m,
    benchmarks: {
      profitFactor: { value: m.profitFactor, benchmark: 1.5, status: m.profitFactor >= 1.5 ? 'above' : m.profitFactor >= 1.0 ? 'near' : 'below', note: m.profitFactor >= 1.5 ? 'Strong — consistent edge' : m.profitFactor >= 1.0 ? 'Positive but thin edge' : 'Losing — review strategy' },
      winRate:       { value: m.winRate, benchmark: 50, status: m.winRate >= 50 ? 'above' : 'below', note: m.winRate >= 60 ? 'High win rate — watch R:R' : m.winRate >= 45 ? 'Acceptable with good R:R' : 'Low win rate — R:R must compensate' },
      riskReward:    { value: m.riskRewardRatio, benchmark: 1.5, status: m.riskRewardRatio !== null ? (m.riskRewardRatio >= 1.5 ? 'above' : 'below') : 'unknown' },
      maxDrawdown:   { value: m.maxDrawdown, benchmarkPct: account_size ? Math.round((m.maxDrawdown / account_size) * 1000) / 10 : null, note: account_size && (m.maxDrawdown / account_size) > 0.05 ? 'Max drawdown exceeds 5% of account — prop firm risk' : 'Within typical prop firm limits' },
    },
    strengths: [],
    weaknesses: [],
    recommendations: [],
  };

  if (m.profitFactor >= 1.5) report.strengths.push('Strong profit factor');
  if (m.winRate >= 55) report.strengths.push('High win rate');
  if (m.riskRewardRatio !== null && m.riskRewardRatio >= 2) report.strengths.push('Excellent R:R ratio');
  if (m.consistencyScore !== null && m.consistencyScore >= 70) report.strengths.push('Consistent daily performance');

  if (m.profitFactor < 1.2) report.weaknesses.push('Low profit factor — edge may be insufficient');
  if (m.winRate < 40) report.weaknesses.push('Low win rate — requires high R:R to be profitable');
  if (m.maxDrawdown > (account_size || 50000) * 0.04) report.weaknesses.push('High drawdown relative to account');
  if (m.maxConsecLosses >= 5) report.weaknesses.push(`${m.maxConsecLosses} consecutive losses — review risk management`);

  if (m.avgWin < Math.abs(m.avgLoss)) report.recommendations.push('Cut losses earlier or let winners run more — avg loss exceeds avg win');
  if (m.tradingDays > 0 && m.totalTrades / m.tradingDays > 10) report.recommendations.push('High trade frequency — review for overtrading');
  if (m.bestDay > Math.abs(m.worstDay) * 3) report.recommendations.push('Best day outsizes worst day — consider consistency rule exposure');

  if (firm) {
    const key = firm.toLowerCase().replace(/[^a-z]/g, '');
    const rules = FIRM_RULES_SIMPLE[key];
    if (rules) {
      const { violations, warnings } = checkViolations(trades, rules);
      report.firmCompliance = { firm: key, violations: violations.length, warnings: warnings.length, passed: violations.length === 0 };
    }
  }

  return { content: [{ type: 'text', text: JSON.stringify(report) }] };
});

// ── HTTP server ────────────────────────────────────────────────────────────

const sessions = new Map();

const httpServer = http.createServer(async (req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (!req.url.startsWith('/mcp')) { res.writeHead(404); res.end(); return; }

  const sessionId = req.headers['mcp-session-id'];
  let transport;

  if (sessionId && sessions.has(sessionId)) {
    transport = sessions.get(sessionId);
  } else {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => sessions.set(id, transport),
    });
    res.on('close', () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      transport.close();
    });
    await server.connect(transport);
  }

  await transport.handleRequest(req, res);
});

httpServer.listen(8080, () => console.log('trade-journal-mcp listening on :8080'));
