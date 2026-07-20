const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classifyFiling, createSecEdgarClient, filingUrl, normalizeCik, normalizeSubmissions } = require('../src/sec-edgar-client');

function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } }; }

test('SEC normalizes CIK and constructs filing URLs', () => {
  assert.equal(normalizeCik(320193), '0000320193');
  assert.equal(filingUrl('320193', '0000320193-26-000001', 'form8-k.htm'), 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/form8-k.htm');
});

test('SEC normalizes submissions and classifies offering risk', () => {
  const filings = normalizeSubmissions({ cik: '320193', name: 'Example', filings: { recent: { form: ['S-3'], filingDate: ['2026-07-15'], reportDate: ['2026-07-14'], acceptanceDateTime: ['20260715120000'], accessionNumber: ['0000320193-26-000001'], primaryDocument: ['s3.htm'] } } }, 'AAPL');
  assert.equal(filings[0].classification.category, 'shelf_registration');
  assert(classifyFiling(filings[0]).reasonCodes.includes('SEC_EDGAR_FILING_RISK'));
});

test('SEC requires enabled flag and identifying user agent', async () => {
  assert.equal((await createSecEdgarClient({ env: { SEC_EDGAR_ENABLED: 'false' } }).filings('AAPL')).reasonCode, 'SEC_EDGAR_DISABLED');
  assert.equal((await createSecEdgarClient({ env: { SEC_EDGAR_ENABLED: 'true' } }).filings('AAPL')).reasonCode, 'SEC_EDGAR_USER_AGENT_MISSING');
});

test('SEC sends user agent and persists accession deduplication with corrupt-state recovery', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-edgar-'));
  fs.writeFileSync(path.join(dir, 'sec-edgar-accessions.json'), '{bad');
  const headers = [];
  const fetchImpl = async (url, init) => {
    headers.push(init.headers['user-agent']);
    if (url.includes('company_tickers')) return response({ 0: { ticker: 'AAPL', cik_str: 320193, title: 'Apple' } });
    return response({ cik: '320193', name: 'Apple', filings: { recent: { form: ['8-K'], filingDate: [new Date().toISOString().slice(0, 10)], reportDate: [null], acceptanceDateTime: [null], accessionNumber: ['one'], primaryDocument: ['one.htm'] } } });
  };
  const client = createSecEdgarClient({ env: { SEC_EDGAR_ENABLED: 'true', SEC_EDGAR_USER_AGENT: 'workflow-2/1.0 ops@example.com' }, fetchImpl, dataDir: dir });
  assert.equal((await client.detectNew('AAPL')).newFilings.length, 1);
  assert.equal((await client.detectNew('AAPL')).newFilings.length, 0);
  assert(headers.every((value) => value === 'workflow-2/1.0 ops@example.com'));
});

test('SEC company facts and explicit bounded filing documents stay non-live', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-facts-'));
  const client = createSecEdgarClient({
    env: { SEC_EDGAR_ENABLED: 'true', SEC_EDGAR_USER_AGENT: 'workflow-2/1.0 test@example.com' },
    dataDir: dir,
    fetchImpl: async (url, init) => {
      assert.equal(init.headers['user-agent'], 'workflow-2/1.0 test@example.com');
      if (String(url).includes('company_tickers')) return response({ 0: { ticker: 'AAPL', cik_str: 320193 } });
      if (String(url).includes('companyfacts')) return response({ facts: { 'us-gaap': { Assets: { units: {} } } } });
      return { ok: true, status: 200, async text() { return '<html>filing</html>'; } };
    },
  });
  const facts = await client.companyFacts('AAPL');
  assert.equal(facts.ok, true);
  assert.equal(facts.liveConfirmationEligible, false);
  const document = await client.filingDocument({ filingUrl: 'https://www.sec.gov/Archives/test.htm' });
  assert.equal(document.ok, true);
  assert.equal(document.liveConfirmationEligible, false);
});

test('SEC classifier distinguishes restructuring and financial restatement evidence', () => {
  assert.equal(classifyFiling({ form: '8-K', primaryDocument: 'restructuring-plan.htm' }).category, 'restructuring');
  assert.equal(classifyFiling({ form: '8-K', primaryDocument: 'financial-restatement.htm' }).category, 'financial_restatement');
  assert.equal(classifyFiling({ form: '424B2', primaryDocument: 'prospectus.htm' }).category, 'offering');
});
