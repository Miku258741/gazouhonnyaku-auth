import * as admin from 'firebase-admin';

// ---- Admin 初期化 ----
function initAdmin() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
  const sa = JSON.parse(raw);
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  return admin.initializeApp({ credential: admin.credential.cert(sa) });
}
initAdmin();
const db = admin.firestore();

export default async function handler(req, res) {
  // デプロイ確認用の印
  res.setHeader('X-Api-Version', 'auth-v3');

  // ===== CORS =====
  const allowedOrigins = [
    'https://gazouhonnyaku-auth.web.app',
    'http://localhost:5000',
  ];
  const origin = req.headers.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  // =================

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ===== 認証（IDトークン） =====
  const authz = req.headers.authorization || '';
  const m = authz.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'missing_token' });

  let email = '';
  try {
    const idToken = m[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    email = decoded.email || '';
    if (!email) return res.status(403).json({ error: 'email_required' });
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }

  // ===== 許可リスト確認 =====
  try {
    const snap = await db.collection('allowedEmails').doc(email).get();
    if (!snap.exists) return res.status(403).json({ error: 'not_allowed' });

    const data = snap.data() || {};

    // active は厳密に boolean true だけ許可
    const isActive = data.active === true;

    // trialEndsAt は Firestore Timestamp 以外（文字列/数値）でも読み取れるように
    let trialEndMs = null;
    if (data.trialEndsAt) {
      if (typeof data.trialEndsAt.toMillis === 'function') {
        trialEndMs = data.trialEndsAt.toMillis();
      } else if (typeof data.trialEndsAt === 'string' || typeof data.trialEndsAt === 'number') {
        const parsed = Date.parse(String(data.trialEndsAt));
        trialEndMs = Number.isNaN(parsed) ? null : parsed;
      }
    }

    if (!isActive) {
      return res.status(403).json({ error: 'inactive' });
    }
    if (data.plan === 'trial' && trialEndMs && trialEndMs < Date.now()) {
      return res.status(403).json({ error: 'trial_expired' });
    }
    // ここまで通れば利用OK
  } catch (e) {
    console.error('[auth/firestore] error', e);
    return res.status(500).json({ error: 'auth_check_failed' });
  }

  // ===== 本処理：OCR → 翻訳 =====
  const { base64ImageData } = req.body || {};
  if (!base64ImageData) {
    return res.status(400).json({ error: 'No image data provided' });
  }

  try {
    // OCR
    const ocrResponse = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{ image: { content: base64ImageData }, features: [{ type: 'TEXT_DETECTION' }] }],
        }),
      }
    );
    const ocrData = await ocrResponse.json();
    const text = ocrData?.responses?.[0]?.fullTextAnnotation?.text;
    if (!text) return res.status(500).json({ error: 'OCR failed' });

    // 翻訳
    const translateResponse = await fetch(
      `https://translation.googleapis.com/language/translate/v2?key=${process.env.GOOGLE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, target: 'ja' }),
      }
    );
    const translateData = await translateResponse.json();
    const translated = translateData?.data?.translations?.[0]?.translatedText;
    if (!translated) return res.status(500).json({ error: 'Translation failed' });

    return res.status(200).json({ translated });
  } catch (err) {
    console.error('[translate] error', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
