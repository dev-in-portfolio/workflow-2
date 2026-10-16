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

const APPROVED_LIVE_MARKET_SYMBOLS = [];

function parseSymbolList(value, fallback = VOLATILE_STOCK_SYMBOLS) {
  if (!value) return fallback.slice();
  const rawValues = Array.isArray(value) ? value : String(value).split(',');
  const parsed = rawValues
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

const LEVERAGED_OR_VOLATILITY_ETFS = new Set([
  'AAPU', 'AAPD', 'AGQ', 'AMDL', 'AMDS', 'BERZ', 'BITU', 'BITX', 'BOIL', 'BULZ', 'BZQ',
  'CONI', 'CONL', 'CURE', 'CWEB', 'DFEN', 'DIG', 'DPST', 'DRN', 'DRV', 'DUST', 'DXD',
  'EDC', 'ERX', 'ERY', 'ETHD', 'ETHT', 'FAS', 'FAZ', 'FNGD', 'FNGU', 'GDXD', 'GDXU',
  'GGLL', 'GGLS', 'GLL', 'HIBL', 'HIBS', 'JDST', 'JNUG', 'KOLD', 'LABD', 'LABU', 'METD',
  'METU', 'MSFD', 'MSFU', 'MSTU', 'MSTZ', 'NAIL', 'NUGT', 'NVD', 'NVDD', 'NVDL', 'NVDU',
  'PLTD', 'PLTU', 'PSQ', 'QID', 'QLD', 'RETL', 'RWM', 'SBIT', 'SCO', 'SDOW', 'SDS',
  'SOXL', 'SOXS', 'SPXL', 'SPXS', 'SPXU', 'SQQQ', 'SRTY', 'SSO', 'SVIX', 'SVXY', 'TBF',
  'TBT', 'TECL', 'TECS', 'TMF', 'TMV', 'TNA', 'TQQQ', 'TSLL', 'TSLQ', 'TSLS', 'TTT',
  'TWM', 'TZA', 'UBT', 'UCO', 'UGL', 'UPRO', 'URTY', 'UVIX', 'UVXY', 'VIXY', 'VXX',
  'WANT', 'WEBL', 'WEBS', 'YANG', 'YINN', 'ZSL',
]);

module.exports = {
  APPROVED_LIVE_MARKET_SYMBOLS,
  LEVERAGED_OR_VOLATILITY_ETFS,
  VOLATILE_STOCK_SYMBOLS,
  parseSymbolList,
  resolveRotatingStockSymbols,
};
