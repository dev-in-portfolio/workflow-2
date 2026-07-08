const path = require('path');
const { updateScannerCandidateOutcomes } = require('./scanner-selection-outcomes');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, ...rest] = arg.slice(2).split('=');
    args[key] = rest.length ? rest.join('=') : true;
  }
  return args;
}

async function main() {
  const args = parseArgs();
  const result = await updateScannerCandidateOutcomes({
    decisionFilePath: args.file ? path.resolve(String(args.file)) : null,
    outcomeFilePath: args.out ? path.resolve(String(args.out)) : null,
    now: args.now ? new Date(String(args.now)).toISOString() : undefined,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = { parseArgs };
