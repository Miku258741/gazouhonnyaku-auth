export default async function handler(req, res) {
  // ===== CORS =====
  const ALLOW = new Set([
    'http://localhost:5000',
    'https://gazouhonnyaku-auth.web.app',
    'https://gazouhonnyaku-auth.firebaseapp.com',
    'https://auth-clean.web.app',
    'https://auth-clean.firebaseapp.com',
  ]);

  const origin = req.headers.origin || '';
  if (origin && ALLOW.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');

  // 許可メソッド
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');

  // ★ ブラウザが要求してきたヘッダーをそのまま許可（最強に安全）
  const reqHeaders = req.headers['access-control-request-headers'];
  res.setHeader('Access-Control-Allow-Headers', reqHeaders || 'Content-Type');

  // （必要なら）クッキー等を使う場合だけ有効化
  // res.setHeader('Access-Control-Allow-Credentials', 'true');

  // プリフライト即返し
  if (req.method === 'OPTIONS') return res.status(204).end();
  // =================

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { base64ImageData } = req.body || {};
  if (!base64ImageData) {
    return res.status(400).json({ error: 'No image data provided' });
  }

  try {
    // --- OCR ---
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

    // --- Translate ---
    const trResponse = await fetch(
      `https://translation.googleapis.com/language/translate/v2?key=${process.env.GOOGLE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, target: 'ja' }),
      }
    );
    const trData = await trResponse.json();
    const translated = trData?.data?.translations?.[0]?.translatedText;
    if (!translated) return res.status(500).json({ error: 'Translation failed' });

    return res.status(200).json({ translated });
  } catch (err) {
    console.error('[translate] error', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
