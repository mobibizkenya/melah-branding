import admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}
const db = admin.firestore();

const SAF_BASE = process.env.MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

async function getToken() {
  const auth = Buffer.from(
    `${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`
  ).toString('base64');

  const res = await fetch(`${SAF_BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  if (!res.ok) throw new Error('OAuth failed: ' + res.status);
  const data = await res.json();
  return data.access_token;
}

function normalizePhone(p) {
  let s = String(p || '').replace(/[^\d+]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('0')) s = '254' + s.slice(1);
  else if (s.startsWith('7') || s.startsWith('1')) s = '254' + s;
  return /^254(7|1)\d{8}$/.test(s) ? s : null;
}

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
         pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'POST only' });

  try {
    const { phone: rawPhone, amount } = req.body || {};
    const phone = normalizePhone(rawPhone);
    if (!phone) return res.status(400).json({ success: false, message: 'Invalid phone number' });
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Invalid amount' });

    const shortcode = process.env.SHORTCODE;           // till: 1816752
    const passkey   = process.env.PASSKEY;
    const ts        = timestamp();
    const password  = Buffer.from(`${shortcode}${passkey}${ts}`).toString('base64');

    // Callback URL MUST carry the shared secret — see callback.js
    const secret = process.env.MPESA_CALLBACK_SECRET;
    const callbackBase = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
    const callbackUrl = `${callbackBase}/api/mpesa/callback${secret ? '?k=' + encodeURIComponent(secret) : ''}`;

    const token = await getToken();

    const stkRes = await fetch(`${SAF_BASE}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: ts,
        TransactionType: 'CustomerBuyGoodsOnline',
        Amount: Math.round(Number(amount)),
        PartyA: phone,
        PartyB: shortcode,
        PhoneNumber: phone,
        CallBackURL: callbackUrl,
        AccountReference: 'MELAH-POS',
        TransactionDesc: 'Melah Branding POS subscription (30 days)'
      })
    });

    const stk = await stkRes.json().catch(() => ({}));
    if (!stkRes.ok || stk.ResponseCode !== '0') {
      return res.status(400).json({
        success: false,
        message: stk.errorMessage || stk.ResponseDescription || 'STK push failed'
      });
    }

    // Persist a "pending" record so the browser's GET poll has something to find.
    await db.collection('mpesa_payments').doc(stk.CheckoutRequestID).set({
      status: 'pending',
      phone,
      amount: Math.round(Number(amount)),
      merchantRequestId: stk.MerchantRequestID || null,
      checkoutRequestId: stk.CheckoutRequestID,
      createdAt: new Date().toISOString()
    }, { merge: true });

    return res.status(200).json({
      success: true,
      checkoutRequestId: stk.CheckoutRequestID,
      customerMessage: stk.CustomerMessage || 'Check your phone for the M-Pesa prompt'
    });
  } catch (err) {
    console.error('stkpush error', err);
    return res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
}
