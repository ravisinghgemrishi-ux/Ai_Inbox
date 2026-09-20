require('dotenv').config();
const express = require('express');
const webhookHandler = require('./api/webhook');

const app = express();
app.use(express.json());

app.post('/api/webhook', (req, res) => webhookHandler(req, res));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Local test server running on http://localhost:${PORT}/api/webhook`);
  console.log('Send a test POST with a sample Zernio event to try it out.');
});
