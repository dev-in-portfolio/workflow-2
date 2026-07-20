const fs = require('fs');
const path = require('path');
const { ProviderRuntime } = require('./provider-runtime');
const { fetchJsonWithTimeout, fetchTextWithTimeout } = require('./source-fetch');
const { nowIso } = require('./util');

const RISK_FORMS = new Set(['S-1', 'S-3', '424B3', '424B5', 'NT 10-K', 'NT 10-Q', '25', '15']);
const CATALYST_FORMS = new Set(['8-K', '10-K', '10-Q', '6-K', '20-F', 'DEF 14A', '3', '4', '5', 'SC 13D', 'SC 13G']);

function normalizeCik(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits ? digits.padStart(10, '0').slice(-10) : null;
}

function filingUrl(cik, accessionNumber, primaryDocument, archivesBaseUrl = 'https://www.sec.gov') {
  const normalizedCik = normalizeCik(cik);
  const accession = String(accessionNumber || '').replace(/-/g, '');
  if (!normalizedCik || !accession || !primaryDocument) return null;
  return `${String(archivesBaseUrl).replace(/\/+$/, '')}/Archives/edgar/data/${Number(normalizedCik)}/${accession}/${encodeURIComponent(primaryDocument)}`;
}

function classifyFiling(filing = {}) {
  const form = String(filing.form || '').toUpperCase();
  const document = String(filing.primaryDocument || '').toLowerCase();
  let category = 'unknown_filing';
  let confidence = 0.4;
  const reasonCodes = [];
  if (['S-1', 'S-3'].includes(form) || form.startsWith('424B')) { category = form.startsWith('S-') ? 'shelf_registration' : 'offering'; confidence = 0.85; reasonCodes.push('SEC_EDGAR_FILING_RISK', 'SEC_EDGAR_DILUTION_RISK'); }
  else if (['NT 10-K', 'NT 10-Q'].includes(form)) { category = 'late_filing'; confidence = 0.95; reasonCodes.push('SEC_EDGAR_FILING_RISK'); }
  else if (form === '25' || form === '15') { category = 'delisting_risk'; confidence = 0.8; reasonCodes.push('SEC_EDGAR_FILING_RISK'); }
  else if (['3', '4', '5'].includes(form)) { category = 'insider_transaction'; confidence = 0.95; reasonCodes.push('SEC_EDGAR_FILING_FOUND'); }
  else if (form === '8-K' || form === '6-K') { category = 'material_event'; confidence = 0.75; reasonCodes.push('SEC_EDGAR_FILING_FOUND'); }
  else if (form === 'DEF 14A') { category = 'executive_change'; confidence = 0.55; reasonCodes.push('SEC_EDGAR_FILING_FOUND'); }
  else if (['SC 13D', 'SC 13G'].includes(form)) { category = 'merger_or_acquisition'; confidence = 0.5; reasonCodes.push('SEC_EDGAR_FILING_FOUND'); }
  else if (['10-K', '10-Q', '20-F'].includes(form)) { category = 'earnings'; confidence = 0.7; reasonCodes.push('SEC_EDGAR_FILING_FOUND'); }
  if (/bankrupt/.test(document)) { category = 'bankruptcy'; confidence = 0.9; reasonCodes.push('SEC_EDGAR_FILING_RISK'); }
  else if (/restructur/.test(document)) { category = 'restructuring'; confidence = 0.85; reasonCodes.push('SEC_EDGAR_FILING_RISK'); }
  else if (/restat/.test(document)) { category = 'financial_restatement'; confidence = 0.8; reasonCodes.push('SEC_EDGAR_FILING_RISK'); }
  else if (/auditor/.test(document)) { category = 'auditor_change'; confidence = 0.65; reasonCodes.push('SEC_EDGAR_FILING_FOUND'); }
  else if (/legal|litigation|regulatory/.test(document)) { category = 'legal_or_regulatory_event'; confidence = 0.6; reasonCodes.push('SEC_EDGAR_FILING_FOUND'); }
  return { category, confidence, matchedEvidence: [form, document].filter(Boolean), filingForm: form, sourceTimestamp: filing.acceptedAt || filing.filingDate || null, reasonCodes };
}

function normalizeSubmissions(body, ticker = null, archivesBaseUrl) {
  const cik = normalizeCik(body?.cik);
  const recent = body?.filings?.recent || {};
  const count = Array.isArray(recent.form) ? recent.form.length : 0;
  return Array.from({ length: count }, (_, index) => {
    const filing = {
      accessionNumber: recent.accessionNumber?.[index] || null,
      filingDate: recent.filingDate?.[index] || null,
      reportDate: recent.reportDate?.[index] || null,
      acceptedAt: recent.acceptanceDateTime?.[index] || null,
      form: recent.form?.[index] || null,
      primaryDocument: recent.primaryDocument?.[index] || null,
      companyName: body?.name || null,
      cik,
      ticker,
    };
    filing.filingUrl = filingUrl(cik, filing.accessionNumber, filing.primaryDocument, archivesBaseUrl);
    filing.classification = classifyFiling(filing);
    return filing;
  });
}

function createSecEdgarClient(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const enabled = String(env.SEC_EDGAR_ENABLED ?? env.MEME_SOURCE_SEC_EDGAR_ENABLED ?? 'false').toLowerCase() === 'true';
  const userAgent = String(env.SEC_EDGAR_USER_AGENT || '').trim();
  const baseUrl = String(env.SEC_EDGAR_BASE_URL || 'https://data.sec.gov').replace(/\/+$/, '');
  const archivesBaseUrl = String(env.SEC_EDGAR_ARCHIVES_BASE_URL || 'https://www.sec.gov').replace(/\/+$/, '');
  const timeoutMs = Number(env.SEC_EDGAR_TIMEOUT_MS || 5000);
  const cacheSeconds = Number(env.SEC_EDGAR_CACHE_SECONDS || 300);
  const dataDir = options.dataDir || 'data/runtime';
  const statePath = path.resolve(dataDir, 'sec-edgar-accessions.json');
  const runtime = options.runtime || new ProviderRuntime({ provider: 'sec_edgar', windowMs: 1000, maxRequests: Number(env.SEC_EDGAR_MAX_REQUESTS_PER_SECOND || 5), statePath: path.resolve(dataDir, 'sec-edgar-usage.json'), logger: options.logger });
  let tickerMap = null;

  async function getTickerMap() {
    if (!enabled) return { ok: false, provider: 'sec_edgar', reasonCode: 'SEC_EDGAR_DISABLED' };
    if (!userAgent) return { ok: false, provider: 'sec_edgar', reasonCode: 'SEC_EDGAR_USER_AGENT_MISSING' };
    if (tickerMap) return { ok: true, map: tickerMap, cached: true };
    const result = await runtime.run('ticker-map', async () => {
      const response = await fetchJsonWithTimeout(fetchImpl, `${archivesBaseUrl}/files/company_tickers.json`, { timeoutMs, headers: { 'user-agent': userAgent } });
      if (response.status === 429 || response.status === 403) return { ok: false, provider: 'sec_edgar', reasonCode: 'SEC_EDGAR_RATE_LIMITED' };
      if (!response.ok || !response.body || typeof response.body !== 'object') return { ok: false, provider: 'sec_edgar', reasonCode: 'SEC_EDGAR_MALFORMED_RESPONSE' };
      const map = {};
      for (const entry of Object.values(response.body)) {
        if (entry?.ticker) map[String(entry.ticker).toUpperCase()] = { cik: normalizeCik(entry.cik_str ?? entry.cik), title: entry.title || null };
      }
      return { ok: true, provider: 'sec_edgar', map };
    }, { cacheSeconds });
    if (result.ok) tickerMap = result.map;
    return result;
  }

  async function filings(symbol) {
    const mapResult = await getTickerMap();
    if (!mapResult.ok) return mapResult;
    const normalizedSymbol = String(symbol || '').trim().toUpperCase();
    const mapping = mapResult.map[normalizedSymbol];
    if (!mapping?.cik) return { ok: false, provider: 'sec_edgar', symbol: normalizedSymbol, reasonCode: 'SEC_EDGAR_CIK_UNRESOLVED' };
    return runtime.run(`submissions:${mapping.cik}`, async () => {
      const response = await fetchJsonWithTimeout(fetchImpl, `${baseUrl}/submissions/CIK${mapping.cik}.json`, { timeoutMs, headers: { 'user-agent': userAgent } });
      if (response.status === 429 || response.status === 403) return { ok: false, provider: 'sec_edgar', reasonCode: 'SEC_EDGAR_RATE_LIMITED' };
      if (!response.ok || !response.body?.filings?.recent) return { ok: false, provider: 'sec_edgar', reasonCode: 'SEC_EDGAR_MALFORMED_RESPONSE' };
      const all = normalizeSubmissions(response.body, normalizedSymbol, archivesBaseUrl);
      const cutoff = Date.now() - Number(env.SEC_EDGAR_LOOKBACK_DAYS || 5) * 86400000;
      return { ok: true, provider: 'sec_edgar', symbol: normalizedSymbol, dataType: 'filings', filings: all.filter((filing) => new Date(filing.filingDate || 0).getTime() >= cutoff), receivedAt: nowIso(), freshness: 'historical', rawDataExcluded: true };
    }, { cacheSeconds });
  }

  async function detectNew(symbol) {
    const result = await filings(symbol);
    if (!result.ok) return result;
    const state = readState(statePath);
    const seen = new Set(state.accessions || []);
    const newFilings = result.filings.filter((filing) => filing.accessionNumber && !seen.has(filing.accessionNumber));
    for (const filing of result.filings) if (filing.accessionNumber) seen.add(filing.accessionNumber);
    writeState(statePath, { version: 1, updatedAt: nowIso(), accessions: [...seen].slice(-10000) });
    return { ...result, newFilings, reasonCode: newFilings.length ? 'SEC_EDGAR_FILING_FOUND' : null };
  }

  async function companyFacts(symbol) {
    const mapResult = await getTickerMap();
    if (!mapResult.ok) return mapResult;
    const normalizedSymbol = String(symbol || '').trim().toUpperCase();
    const mapping = mapResult.map[normalizedSymbol];
    if (!mapping?.cik) return { ok: false, provider: 'sec_edgar', symbol: normalizedSymbol, reasonCode: 'SEC_EDGAR_CIK_UNRESOLVED' };
    return runtime.run(`companyfacts:${mapping.cik}`, async () => {
      const response = await fetchJsonWithTimeout(fetchImpl, `${baseUrl}/api/xbrl/companyfacts/CIK${mapping.cik}.json`, { timeoutMs, headers: { 'user-agent': userAgent } });
      if ([403, 429].includes(response.status)) return { ok: false, provider: 'sec_edgar', reasonCode: 'SEC_EDGAR_RATE_LIMITED' };
      if (!response.ok || !response.body?.facts || typeof response.body.facts !== 'object') return { ok: false, provider: 'sec_edgar', reasonCode: 'SEC_EDGAR_MALFORMED_RESPONSE' };
      return { ok: true, provider: 'sec_edgar', symbol: normalizedSymbol, cik: mapping.cik, dataType: 'company_facts', facts: response.body.facts, receivedAt: nowIso(), freshness: 'historical', liveConfirmationEligible: false, rawDataExcluded: true };
    }, { cacheSeconds });
  }

  async function filingDocument(filing, { maxBytes = 250000 } = {}) {
    const url = filing?.filingUrl || filingUrl(filing?.cik, filing?.accessionNumber, filing?.primaryDocument, archivesBaseUrl);
    if (!enabled) return { ok: false, provider: 'sec_edgar', reasonCode: 'SEC_EDGAR_DISABLED' };
    if (!userAgent) return { ok: false, provider: 'sec_edgar', reasonCode: 'SEC_EDGAR_USER_AGENT_MISSING' };
    if (!url) return { ok: false, provider: 'sec_edgar', reasonCode: 'SEC_EDGAR_MALFORMED_RESPONSE' };
    return runtime.run(`document:${url}`, async () => {
      const response = await fetchTextWithTimeout(fetchImpl, url, { timeoutMs, headers: { 'user-agent': userAgent } });
      if ([403, 429].includes(response.status)) return { ok: false, provider: 'sec_edgar', reasonCode: 'SEC_EDGAR_RATE_LIMITED' };
      if (!response.ok) return { ok: false, provider: 'sec_edgar', reasonCode: 'SEC_EDGAR_PROVIDER_FAILURE' };
      const text = String(response.text || '');
      if (!text || Buffer.byteLength(text) > Math.max(1000, Number(maxBytes) || 250000)) return { ok: false, provider: 'sec_edgar', reasonCode: 'SEC_EDGAR_DOCUMENT_TOO_LARGE' };
      return { ok: true, provider: 'sec_edgar', dataType: 'filing_document', filingUrl: url, text, receivedAt: nowIso(), freshness: 'historical', liveConfirmationEligible: false };
    }, { cacheSeconds });
  }

  async function selfTest() {
    const result = await getTickerMap();
    runtime.health.authenticationStatus = result.ok ? 'identity_accepted' : userAgent ? 'unverified' : 'missing';
    runtime.health.capabilities = { authentication: runtime.health.authenticationStatus, filings: result.ok, companyFacts: 'untested', filingDocuments: 'supported_on_demand', quotes: false, realTimeQuotes: false, referenceData: result.ok };
    return { provider: 'sec_edgar', capabilities: runtime.health.capabilities, reasonCode: result.reasonCode || null };
  }
  return { getTickerMap, filings, detectNew, companyFacts, filingDocument, selfTest, health: () => runtime.snapshot({ enabled, configured: Boolean(userAgent), status: !enabled ? 'disabled' : userAgent ? runtime.health.status : 'degraded', identityConfigured: Boolean(userAgent), authenticationStatus: runtime.health.authenticationStatus }) };
}

function readState(filePath) { try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return { accessions: [] }; } }
function writeState(filePath, value) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); const temp = `${filePath}.${process.pid}.tmp`; fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`); fs.renameSync(temp, filePath); }

module.exports = { CATALYST_FORMS, RISK_FORMS, classifyFiling, createSecEdgarClient, filingUrl, normalizeCik, normalizeSubmissions };
