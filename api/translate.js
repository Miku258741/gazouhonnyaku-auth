// ---- Firebase Admin を使うための import（ESM） ----
import * as admin from 'firebase-admin';

// Admin SDK 初期化（多重初期化防止）
function initAdmin() {
  if (admin.apps.length) return admin.app();

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
  }
  const sa = JSON.parse(raw);
  // 改行エスケープを実際の改行へ
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');

  return admin.initializeApp({
    credential: admin.credential.cert(sa),
  });
}

const app = initAdmin();
const db = admin.firestore();

export default async function handler(req, res) {
  // ===== CORS =====
  const allowedOrigins = [
    'https://gazouhonnyaku-auth.web.app', // 本番
    'http://localhost:5000',               // ローカル
  ];
  const origin = req.headers.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '86400'); // 24h

  if (req.method === 'OPTIONS') return res.status(204).end();
  // =================

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ====== 認証（IDトークン） ======
  try {
    const authz = req.headers.authorization || '';
    const m = authz.match(/^Bearer (.+)$/);
    if (!m) return res.status(401).json({ error: 'missing_token' });

    const idToken = m[1];
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: 'invalid_token' });
    }

    const email = decoded.email;
    if (!email) {
      return res.status(403).json({ error: 'email_required' });
    }

    // ====== Firestore 許可リスト確認 ======
    const doc = await db.collection('allowedEmails').doc(email).get();
    if (!doc.exists) {
      return res.status(403).json({ error: 'not_allowed' });
    }
    const data = doc.data() || {};
    const active = !!data.active;
    const trialEndsAt = data.trialEndsAt; // Timestamp 期待
    const nowMs = Date.now();
    const trialEndMs =
      trialEndsAt && typeof trialEndsAt.toMillis === 'function'
        ? trialEndsAt.toMillis()
        : null;

    if (!active) {
      return res.status(403).json({ error: 'inactive' });
    }
    if (trialEndMs && trialEndMs < nowMs) {
      return res.status(403).json({ error: 'trial_expired' });
    }
    // ====== ここまで通れば利用OK ======
  } catch (e) {
    console.error('[auth/firestore] error', e);
    return res.status(500).json({ error: 'auth_check_failed' });
  }

  // ====== 本処理：OCR → 翻訳 ======
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
          requests: [
            {
              image: { content: base64ImageData },
              features: [{ type: 'TEXT_DETECTION' }],
            },
          ],
        }),
      }
    );
    const ocrData = await ocrResponse.json();
    const text = ocrData?.responses?.[0]?.fullTextAnnotation?.text;

    if (!text) {
      return res.status(500).json({ error: 'OCR failed' });
    }

    // 翻訳
    const translateResponse = await fetch(
      `https://translation.googleapis.com/language/translate/v2?key=${process.env.GOOGLE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: text,
          target: 'ja',
        }),
      }
    );
    const translateData = await translateResponse.json();
    const translated = translateData?.data?.translations?.[0]?.translatedText;

    if (!translated) {
      return res.status(500).json({ error: 'Translation failed' });
    }

    return res.status(200).json({ translated });
  } catch (err) {
    console.error('[translate] error', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
