const VOLATILE_STOCK_SYMBOLS = [
  'ICCM',
  'EHGO',
  'VRM',
  'SDOT',
  'BIRD',
  'RGNT',
  'VRXA',
  'SPRO',
  'JLHL',
  'EZGO',
  'LNKS',
  'VMAR',
  'CLWT',
  'MFI',
  'NVA',
  'MTEN',
  'CUPR',
  'FTHM',
  'OBAI',
  'CAST',
  'UTSI',
  'SOWG',
  'EBON',
  'HQ',
  'ILAG',
  'TDTH',
  'LICN',
  'LNAI',
  'ELTX',
  'GELS',
  'WYHG',
  'BRAI',
  'GDHG',
  'VSME',
  'CREG',
  'ANTX',
  'VCIG',
  'MCRP',
  'RXT',
  'FRTT',
  'SLBT',
  'TGE',
  'ARQQ',
  'INDP',
  'FLNT',
  'CHR',
  'AMOD',
  'PLBL',
  'CRE',
  'SXTP',
  'AHMA',
  'MYSE',
  'AIOS',
  'SHAZ',
  'KALA',
  'GWAV',
  'BGDE',
  'BNAI',
  'GMM',
  'RGC',
  'AGCC',
  'BNR',
  'FLZH',
  'CMTL',
  'BRLS',
  'ERNA',
  'QXL',
  'AMSS',
  'BWEN',
  'RGNX',
  'TDIC',
  'NCT',
  'ANY',
  'QTEX',
  'DSY',
  'QNT',
  'WFF',
  'BESS',
  'AERT',
  'CRVO',
  'EDSA',
  'MOBI',
  'FOXX',
  'NEOV',
  'SEAT',
  'RDGT',
  'PLRZ',
  'RNAC',
  'SPHL',
  'MTAL',
  'JEM',
  'IFRX',
  'NTLA',
  'HUBC',
  'PRFX',
  'SLXN',
  'BENF',
  'PCLA',
  'BYAH',
  'NXTS',
];

function parseSymbolList(value, fallback = VOLATILE_STOCK_SYMBOLS) {
  if (!value) return fallback.slice();
  const parsed = String(value)
    .split(',')
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean)
    .map((symbol) => {
      if (symbol.includes('/')) return symbol;
      if (symbol.endsWith('USDT')) return `${symbol.slice(0, -4)}/USDT`;
      if (symbol.endsWith('USD')) return `${symbol.slice(0, -3)}/USD`;
      return symbol;
    });
  return parsed.length ? [...new Set(parsed)] : fallback.slice();
}

function resolveRotatingStockSymbols(value, minimumPreferredCount = 20) {
  const parsed = parseSymbolList(value, []);
  if (parsed.length >= minimumPreferredCount) {
    return parsed;
  }
  return VOLATILE_STOCK_SYMBOLS.slice();
}

module.exports = {
  VOLATILE_STOCK_SYMBOLS,
  parseSymbolList,
  resolveRotatingStockSymbols,
};
