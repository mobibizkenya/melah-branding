import admin from 'firebase-admin';

// Initialize Firebase Admin safely
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}
const db = admin.firestore();

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { Body: { stkCallback } } = req.body;
  
  // ResultCode 0 means SUCCESS
  if (stkCallback.ResultCode === 0) {
    // Extract the orgId we passed as AccountReference
    const orgId = stkCallback.CallbackMetadata.Item.find(i => i.Name === 'AccountReference')?.Value;
    
    if (orgId) {
      const newExpiry = Date.now() + (30 * 24 * 60 * 60 * 1000); // 30 Days

      try {
        await db.collection('subscriptions').doc(orgId).set({
          status: 'active',
          paidUntil: newExpiry,
          lastPayment: Date.now(),
          mpesaReceipt: stkCallback.CallbackMetadata.Item.find(i => i.Name === 'MpesaReceiptNumber')?.Value || 'Unknown'
        }, { merge: true });

        console.log(`✅ Subscription renewed for org: ${orgId}`);
      } catch (err) {
        console.error('❌ Firestore update failed:', err);
      }
    }
  }

  // Safaricom expects a 200 OK response
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
}
