import admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}
const db = admin.firestore();

const PAYMENTS_COLLECTION = 'mpesa_payments';
const SUBSCRIPTION_DOC = 'main';
const PLAN_DAYS = 30;

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  /* ============================================================
     GET  — browser only (status poll OR trial init)
     ============================================================ */
  if (req.method === 'GET') {
    const { action, checkoutRequestId } = req.query;

    // --- ?action=init : start the 30-day trial if missing ---
    if (action === 'init') {
      try {
        const ref = db.collection('subscription').doc(SUBSCRIPTION_DOC);
        const snap = await ref.get();

        if (!snap.exists) {
          const now = new Date();
          const expiry = addDays(now, PLAN_DAYS);
          await ref.set({
            subscriptionStart: now.toISOString(),
            subscriptionExpiry: expiry.toISOString(),
            subscriptionPayments: [],
            createdAt: now.toISOString()
          });
          return res.status(200).json({
            status: 'trial-started',
            subscriptionExpiry: expiry.toISOString()
          });
        }

        const d = snap.data();
        const expiry = d.subscriptionExpiry ? new Date(d.subscriptionExpiry) : null;
        const active = expiry && expiry.getTime() > Date.now();
        return res.status(200).json({
          status: active ? 'active' : 'expired',
          subscriptionExpiry: d.subscriptionExpiry || null
        });
      } catch (err) {
        console.error('init error', err);
        return res.status(500).json({ status: 'error', message: err.message });
      }
    }

    // --- ?checkoutRequestId=... : payment status ---
    if (!checkoutRequestId) {
      return res.status(400).json({ status: 'error', message: 'checkoutRequestId or action required' });
    }

    try {
      const doc = await db.collection(PAYMENTS_COLLECTION).doc(checkoutRequestId).get();
      if (!doc.exists) return res.status(200).json({ status: 'pending' });

      const d = doc.data();
      if (d.status === 'success') {
        return res.status(200).json({
          status: 'success',
          mpesaReceipt: d.mpesaReceipt || null,
          amount: d.amount || null
        });
      }
      if (d.status === 'failed') {
        return res.status(200).json({
          status: 'failed',
          message: d.message || 'Payment failed'
        });
      }
      return res.status(200).json({ status: 'pending' });
    } catch (err) {
      console.error('status GET error', err);
      return res.status(500).json({ status: 'error', message: err.message });
    }
  }

  /* ============================================================
     POST — Safaricom only (secret-gated)
     ============================================================ */
  if (req.method === 'POST') {
    const expectedSecret = process.env.MPESA_CALLBACK_SECRET;
    if (expectedSecret && req.query.k !== expectedSecret) {
      console.warn('callback secret mismatch — ignoring POST');
      // Return 200 so a re-attempt doesn't happen; Safaricom can't fix a wrong URL.
      return res.status(200).json({ ok: true });
    }

    try {
      const cb = req.body?.Body?.stkCallback;
      if (!cb) return res.status(200).json({ ok: true });

      const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = cb;
      const meta = {};
      (CallbackMetadata?.Item || []).forEach(item => {
        meta[item.Name] = item.Value;
      });

      const isSuccess = ResultCode === 0;
      const now = new Date();

      // 1) Record the payment outcome.
      await db.collection(PAYMENTS_COLLECTION).doc(CheckoutRequestID).set({
        status: isSuccess ? 'success' : 'failed',
        mpesaReceipt: meta.MpesaReceiptNumber || null,
        amount: meta.Amount || null,
        phone: meta.PhoneNumber || null,
        message: isSuccess ? 'OK' : (ResultDesc || 'Payment failed'),
        updatedAt: now.toISOString(),
        rawCallback: cb
      }, { merge: true });

      // 2) Extend the subscription — THIS is what makes the paywall real.
      if (isSuccess) {
        const subRef = db.collection('subscription').doc(SUBSCRIPTION_DOC);
        const subSnap = await subRef.get();
        const existing = subSnap.exists ? subSnap.data() : {};

        const currentExpiry = existing.subscriptionExpiry
          ? new Date(existing.subscriptionExpiry)
          : null;
        const base = currentExpiry && currentExpiry.getTime() > now.getTime()
          ? currentExpiry
          : now;
        const newExpiry = addDays(base, PLAN_DAYS);

        const payments = [
          ...(existing.subscriptionPayments || []),
          {
            receipt: meta.MpesaReceiptNumber || CheckoutRequestID,
            phone: meta.PhoneNumber || null,
            amount: meta.Amount || null,
            at: now.toISOString(),
            checkoutRequestId: CheckoutRequestID
          }
        ].slice(-50);

        await subRef.set({
          subscriptionStart: existing.subscriptionStart || now.toISOString(),
          subscriptionExpiry: newExpiry.toISOString(),
          subscriptionLastPayment: now.toISOString(),
          subscriptionPayments: payments
        }, { merge: true });

        console.log(`Subscription extended to ${newExpiry.toISOString()} for ${meta.MpesaReceiptNumber}`);
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('callback POST error', err);
      // Always 200 so Safaricom doesn't retry an unrecoverable error.
      return res.status(200).json({ ok: true });
    }
  }

  return res.status(405).json({ status: 'error', message: 'Method not allowed' });
}
