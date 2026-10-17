import { prisma } from './db';

export const SUPPORTED_CURRENCIES: Record<string, { name: string; nameEn: string; symbol: string; decimal: number; symbolBefore: boolean; region: string }> = {
  USD: { name: '美元', nameEn: 'US Dollar', symbol: '$', decimal: 2, symbolBefore: true, region: '美洲' },
  CAD: { name: '加拿大元', nameEn: 'Canadian Dollar', symbol: 'C$', decimal: 2, symbolBefore: true, region: '美洲' },
  BRL: { name: '巴西雷亚尔', nameEn: 'Brazilian Real', symbol: 'R$', decimal: 2, symbolBefore: true, region: '美洲' },
  MXN: { name: '墨西哥比索', nameEn: 'Mexican Peso', symbol: 'MX$', decimal: 2, symbolBefore: true, region: '美洲' },
  EUR: { name: '欧元', nameEn: 'Euro', symbol: '€', decimal: 2, symbolBefore: true, region: '欧洲' },
  GBP: { name: '英镑', nameEn: 'British Pound', symbol: '£', decimal: 2, symbolBefore: true, region: '欧洲' },
  CHF: { name: '瑞士法郎', nameEn: 'Swiss Franc', symbol: 'CHF', decimal: 2, symbolBefore: false, region: '欧洲' },
  SEK: { name: '瑞典克朗', nameEn: 'Swedish Krona', symbol: 'kr', decimal: 2, symbolBefore: false, region: '欧洲' },
  NOK: { name: '挪威克朗', nameEn: 'Norwegian Krone', symbol: 'kr', decimal: 2, symbolBefore: false, region: '欧洲' },
  DKK: { name: '丹麦克朗', nameEn: 'Danish Krone', symbol: 'kr', decimal: 2, symbolBefore: false, region: '欧洲' },
  PLN: { name: '波兰兹罗提', nameEn: 'Polish Zloty', symbol: 'zł', decimal: 2, symbolBefore: false, region: '欧洲' },
  CZK: { name: '捷克克朗', nameEn: 'Czech Koruna', symbol: 'Kč', decimal: 2, symbolBefore: false, region: '欧洲' },
  HUF: { name: '匈牙利福林', nameEn: 'Hungarian Forint', symbol: 'Ft', decimal: 0, symbolBefore: false, region: '欧洲' },
  SGD: { name: '新币', nameEn: 'Singapore Dollar', symbol: 'S$', decimal: 2, symbolBefore: true, region: '亚太' },
  HKD: { name: '港币', nameEn: 'Hong Kong Dollar', symbol: 'HK$', decimal: 2, symbolBefore: true, region: '亚太' },
  AUD: { name: '澳元', nameEn: 'Australian Dollar', symbol: 'A$', decimal: 2, symbolBefore: true, region: '亚太' },
  NZD: { name: '新西兰元', nameEn: 'New Zealand Dollar', symbol: 'NZ$', decimal: 2, symbolBefore: true, region: '亚太' },
  JPY: { name: '日元', nameEn: 'Japanese Yen', symbol: '¥', decimal: 0, symbolBefore: true, region: '亚太' },
  MYR: { name: '马币', nameEn: 'Malaysian Ringgit', symbol: 'RM', decimal: 2, symbolBefore: true, region: '亚太' },
  CNY: { name: '人民币', nameEn: 'Chinese Yuan', symbol: '¥', decimal: 2, symbolBefore: true, region: '亚太' },
  TWD: { name: '新台币', nameEn: 'New Taiwan Dollar', symbol: 'NT$', decimal: 0, symbolBefore: true, region: '亚太' },
  THB: { name: '泰铢', nameEn: 'Thai Baht', symbol: '฿', decimal: 2, symbolBefore: false, region: '亚太' },
  PHP: { name: '菲律宾比索', nameEn: 'Philippine Peso', symbol: '₱', decimal: 2, symbolBefore: true, region: '亚太' },
  ILS: { name: '以色列新谢克尔', nameEn: 'Israeli Shekel', symbol: '₪', decimal: 2, symbolBefore: true, region: '中东' },
};

export function getPaymentMethods(currency: string): { method: string; label: string; hasFee: boolean; feePercent: number }[] {
  if (currency === 'MYR') {
    return [
      { method: 'TNG', label: 'Touch \'n Go', hasFee: false, feePercent: 0 },
      { method: 'ShopeePay', label: 'ShopeePay', hasFee: false, feePercent: 0 },
      { method: 'PayPal', label: 'PayPal', hasFee: false, feePercent: 0 },
    ];
  }
  if (currency === 'CNY') {
    return [
      { method: 'Alipay', label: '支付宝', hasFee: false, feePercent: 0 },
    ];
  }
  return [
    { method: 'PayPal', label: 'PayPal', hasFee: true, feePercent: 4.4 },
  ];
}

export function formatCurrency(amount: number, currency: string): string {
  const info = SUPPORTED_CURRENCIES[currency];
  if (!info) return `$${amount.toFixed(2)}`;
  const rounded = info.decimal === 0 ? Math.round(amount) : parseFloat(amount.toFixed(info.decimal));
  const formatted = info.decimal === 0
    ? Math.round(amount).toLocaleString()
    : amount.toFixed(info.decimal).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return info.symbolBefore ? `{info.symbol}${formatted}` : `${formatted} ${info.symbol}`;
}

export function getRegionCurrency(region: string): string {
  const map: Record<string, string> = {
    CN: 'CNY', HK: 'HKD', TW: 'TWD', US: 'USD', JP: 'JPY', KR: 'USD',
    GB: 'GBP', DE: 'EUR', FR: 'EUR', BR: 'BRL', RU: 'USD', SA: 'USD',
    TH: 'THB', VN: 'USD', ID: 'USD', IN: 'USD', AU: 'AUD', SG: 'SGD',
    MY: 'MYR', MX: 'MXN', CA: 'CAD', IL: 'ILS', PH: 'PHP',
    CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF',
    NZ: 'NZD',
  };
  return map[region] || 'USD';
}

export async function fetchAndStoreRates(): Promise<boolean> {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!res.ok) throw new Error(`Rate API error: ${res.status}`);
    const data = (await res.json()) as any;
    if (data.result !== 'success') throw new Error('Rate API returned non-success');

    const rates = data.rates;
    const supportedCodes = Object.keys(SUPPORTED_CURRENCIES);

    for (const code of supportedCodes) {
      if (code === 'USD') continue;
      const rate = rates[code];
      if (!rate) continue;

      await prisma.exchangeRate.upsert({
        where: { base_target: { base: 'USD', target: code } },
        update: { rate, fetchedAt: new Date() },
        create: { base: 'USD', target: code, rate },
      });
    }

    console.log(`[ExchangeRate] Updated ${supportedCodes.length - 1} rates`);
    return true;
  } catch (err) {
    console.error('[ExchangeRate] Failed to fetch rates:', err);
    return false;
  }
}

export async function getRate(targetCurrency: string): Promise<number> {
  if (targetCurrency === 'USD') return 1;
  try {
    const rate = await prisma.exchangeRate.findUnique({
      where: { base_target: { base: 'USD', target: targetCurrency } },
    });
    return rate?.rate || 1;
  } catch { return 1; }
}

export async function convertFromUSD(usdAmount: number, targetCurrency: string): Promise<number> {
  const rate = await getRate(targetCurrency);
  const info = SUPPORTED_CURRENCIES[targetCurrency];
  const decimal = info?.decimal ?? 2;
  const converted = usdAmount * rate;
  return decimal === 0 ? Math.round(converted) : parseFloat(converted.toFixed(decimal));
}

export async function getAllRates(): Promise<Record<string, number>> {
  try {
    const rates = await prisma.exchangeRate.findMany({ where: { base: 'USD' } });
    const result: Record<string, number> = { USD: 1 };
    for (const r of rates) result[r.target] = r.rate;
    return result;
  } catch { return { USD: 1 }; }
}

let rateUpdateInterval: NodeJS.Timeout | null = null;
let rateBootTimer: NodeJS.Timeout | null = null;

export function startRateUpdater() {
  // 冷启动错峰：先等 5s 让 wakeDatabase/schema 检查完成、数据库连接稳定，
  // 避免与启动期并发写盘抢锁触发 P1008 socket timeout。
  rateBootTimer = setTimeout(() => { fetchAndStoreRates(); }, 5000);
  rateUpdateInterval = setInterval(() => { fetchAndStoreRates(); }, 24 * 60 * 60 * 1000);
  console.log('[ExchangeRate] Rate updater started (first fetch in 5s, then 24h)');
}

export function stopRateUpdater() {
  if (rateUpdateInterval) clearInterval(rateUpdateInterval);
  if (rateBootTimer) clearTimeout(rateBootTimer);
}