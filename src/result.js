function ok(value) {
  return { ok: true, value };
}

function fail(error, reasonCodes = []) {
  return { ok: false, error, reasonCodes };
}

module.exports = { ok, fail };
