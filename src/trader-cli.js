const { startMinimalTradingServer } = require('./minimal-cli');

function main(env = process.env) {
  startMinimalTradingServer(env);
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  startMinimalTradingServer,
};
