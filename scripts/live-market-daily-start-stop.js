const { runLiveMarketDailyAutomation, formatAutomationSummary } = require('../src/live-market-daily-automation');

async function main(argv = process.argv.slice(2), env = process.env) {
  const actionArg = parseAction(argv, env);
  const result = await runLiveMarketDailyAutomation({
    action: actionArg,
    env,
  });
  process.stdout.write(`${formatAutomationSummary(result)}\n`);
  return result;
}

function parseAction(argv, env = process.env) {
  const option = argv.find((value) => /^(start|stop)$/i.test(String(value || '').trim()));
  if (option) {
    return String(option).trim().toLowerCase();
  }
  const envAction = String(env.LIVE_MARKET_AUTOMATION_ACTION || env.LIVE_MARKET_DAILY_ACTION || '').trim().toLowerCase();
  if (/^(start|stop)$/.test(envAction)) {
    return envAction;
  }
  return 'start';
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  parseAction,
};
