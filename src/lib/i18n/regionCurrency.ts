// 地区 → 默认货币。与服务端 getRegionCurrency（server/src/services/exchangeRate.ts）
// 保持同一口径；未列出的地区回退 USD。实际写入前会在支持的货币清单里再校验一次。
export const REGION_DEFAULT_CURRENCY: Record<string, string> = {
  CN: 'CNY', HK: 'HKD', TW: 'TWD', US: 'USD', JP: 'JPY', KR: 'USD',
  GB: 'GBP', DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', PT: 'EUR',
  NL: 'EUR', BE: 'EUR', AT: 'EUR', BR: 'BRL', RU: 'USD', SA: 'USD',
  AE: 'USD', TH: 'THB', VN: 'USD', ID: 'USD', IN: 'USD', PK: 'USD',
  BD: 'USD', TR: 'USD', AU: 'AUD', SG: 'SGD', MY: 'MYR', MX: 'MXN',
  CA: 'CAD', IL: 'ILS', PH: 'PHP', CH: 'CHF', SE: 'SEK', NO: 'NOK',
  DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', NZ: 'NZD',
};

export function defaultCurrencyForRegion(region: string): string {
  return REGION_DEFAULT_CURRENCY[region] || 'USD';
}
