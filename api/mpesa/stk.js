import axios from 'axios';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { phone, amount, orgId } = req.body;
  
  if (!phone || !amount || !orgId) {
    return res.status(400).json({ error: 'Missing required fields (phone, amount, orgId)' });
  }

  const baseUrl = process.env.MPESA_ENV === 'production' 
    ? 'https://api.safaricom.co.ke' 
    : 'https://sandbox.safaricom.co.ke';

  // Your Store Number (used for password & business shortcode)
  const storeNumber = process.env.MPESA_SHORTCODE || '1347027'; 
  
  // Your Till Number (used for routing the payment)
  const tillNumber = '1816752'; 

  try {
    // 1. Get OAuth Token
    const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
    const { data: { access_token } } = await axios.get(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` }
    });

    // 2. Generate Timestamp in East Africa Time (EAT)
    const now = new Date();
    const eatOffset = 3 * 60 * 60 * 1000; 
    const eatDate = new Date(now.getTime() + eatOffset);
    
    const year = eatDate.getUTCFullYear();
    const month = String(eatDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(eatDate.getUTCDate()).padStart(2, '0');
    const hours = String(eatDate.getUTCHours()).padStart(2, '0');
    const minutes = String(eatDate.getUTCMinutes()).padStart(2, '0');
    const seconds = String(eatDate.getUTCSeconds()).padStart(2, '0');
    
    const timestamp = `${year}${month}${day}${hours}${minutes}${seconds}`;

    // 3. Generate Password using STORE NUMBER
    const password = Buffer.from(`${storeNumber}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');

    // 4. Initiate STK Push
    const payload = {
      BusinessShortCode: storeNumber, // STORE NUMBER
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline', 
      Amount: Math.round(amount),
      PartyA: phone,
      PartyB: tillNumber, // TILL NUMBER (This is the fix!)
      PhoneNumber: phone,
      CallBackURL: `https://${req.headers.host}/api/mpesa/callback`,
      AccountReference: 'MOBIBIZ',
      TransactionDesc: 'POS Subscription'
    };

    const stkRes = await axios.post(`${baseUrl}/mpesa/stkpush/v1/processrequest`, payload, {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    res.status(200).json({ ok: true, data: stkRes.data });

  } catch (error) {
    const errorData = error.response?.data || error.message;
    console.error('SAFARICOM STK ERROR:', JSON.stringify(errorData, null, 2));
    res.status(500).json({ error: 'Failed to initiate M-Pesa payment', details: errorData });
  }
}
