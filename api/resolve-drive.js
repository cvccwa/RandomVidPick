import https from 'https';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://cvccwa.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id, token } = req.query;
  if (!id || !token) return res.status(400).json({ error: 'missing id or token' });

  const request = https.request(
    {
      hostname: 'www.googleapis.com',
      path: `/drive/v3/files/${encodeURIComponent(id)}?alt=media`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    },
    (driveRes) => {
      const { statusCode, headers } = driveRes;
      driveRes.resume();
      if ((statusCode === 302 || statusCode === 303 || statusCode === 307) && headers.location) {
        res.json({ url: headers.location });
      } else {
        res.json({ url: null, status: statusCode });
      }
    }
  );

  request.on('error', (err) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

  request.end();
}
