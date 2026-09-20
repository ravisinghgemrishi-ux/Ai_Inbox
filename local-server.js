require('dotenv').config();
const express = require('express');
const webhookHandler = require('./api/webhook');
const previewHandler = require('./api/preview-reply');

const app = express();
app.post('/api/webhook', (req, res) => webhookHandler(req, res));
app.get('/api/preview-reply', (req, res) => previewHandler(req, res));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Local test server running on http://localhost:${PORT}`);
});
