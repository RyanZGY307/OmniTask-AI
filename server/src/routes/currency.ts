import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { prisma } from '../services/db';
import { SUPPORTED_CURRENCIES, getAllRates, fetchAndStoreRates, getPaymentMethods, formatCurrency, convertFromUSD } from '../services/exchangeRate';

const router = Router();

router.get('/supported', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const rates = await getAllRates();
    const currencies = Object.entries(SUPPORTED_CURRENCIES).map(([code, info]) => ({
      code,
      ...info,
      rate: rates[code] || null,
    }));
    res.json({ currencies });
  } catch { res.status(500).json({ error: '获取货币列表失败' }); }
});

router.get('/rates', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const rates = await getAllRates();
    res.json({ rates, base: 'USD', updatedAt: new Date().toISOString() });
  } catch { res.status(500).json({ error: '获取汇率失败' }); }
});

router.put('/preference', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { currency } = req.body;
    if (!currency || !SUPPORTED_CURRENCIES[currency]) return res.status(400).json({ error: '不支持的货币' });
    await prisma.user.update({ where: { id: req.user!.id }, data: { currency } });
    res.json({ success: true, currency });
  } catch { res.status(500).json({ error: '更新失败' }); }
});

router.get('/payment-methods', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    const currency = user?.currency || 'USD';
    const methods = getPaymentMethods(currency);
    res.json({ currency, methods });
  } catch { res.status(500).json({ error: '获取支付方式失败' }); }
});

router.post('/refresh', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const ok = await fetchAndStoreRates();
    res.json({ success: ok });
  } catch { res.status(500).json({ error: '刷新汇率失败' }); }
});

router.post('/preview', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { usdAmount, currency: targetCurrency } = req.body;
    if (!usdAmount || !targetCurrency) return res.status(400).json({ error: '参数不完整' });
    const localAmount = await convertFromUSD(usdAmount, targetCurrency);
    const rate = localAmount / usdAmount;
    const methods = getPaymentMethods(targetCurrency);
    const paypalMethod = methods.find(m => m.method === 'PayPal');
    const feeAmount = paypalMethod?.hasFee ? parseFloat((localAmount * paypalMethod.feePercent / 100).toFixed(SUPPORTED_CURRENCIES[targetCurrency]?.decimal ?? 2)) : 0;
    const totalAmount = localAmount + feeAmount;
    res.json({
      usdAmount,
      currency: targetCurrency,
      rate,
      localAmount,
      feeAmount,
      totalAmount,
      formattedLocal: formatCurrency(localAmount, targetCurrency),
      formattedFee: formatCurrency(feeAmount, targetCurrency),
      formattedTotal: formatCurrency(totalAmount, targetCurrency),
      methods,
    });
  } catch { res.status(500).json({ error: '预览失败' }); }
});

export default router;