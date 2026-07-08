const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const DATA_FILE = path.join(__dirname, 'data.json');

function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { escrow: { state: 'IDLE', funds: 0 }, listings: [] };
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Ensure initial data exists
let store = readData();
if (!store.listings || store.listings.length === 0) {
  store.listings = [
    {
      id: 1,
      title: 'Premium Maize Grains',
      seller: 'Mbalinge Esther',
      price: 1200000,
      lot: '50 Bags (100kg/bag)',
      region: 'Western Uganda',
      estDelivery: '3-5 Days',
      quality: 'Grade A'
    }
  ];
  writeData(store);
}

app.get('/api/listings', (req, res) => {
  store = readData();
  res.json({ listings: store.listings });
});

app.get('/api/escrow', (req, res) => {
  store = readData();
  res.json({ escrow: store.escrow });
});

app.post('/api/orders', (req, res) => {
  // Simulate buyer locking funds into escrow
  store = readData();
  const listing = store.listings[0];
  store.escrow = { state: 'FUNDED', funds: listing.price, listingId: listing.id };
  writeData(store);
  res.json({ escrow: store.escrow });
});

app.post('/api/escrow/ship', (req, res) => {
  store = readData();
  if (store.escrow && store.escrow.state === 'FUNDED') {
    store.escrow.state = 'SHIPPED';
    writeData(store);
  }
  res.json({ escrow: store.escrow });
});

app.post('/api/escrow/release', (req, res) => {
  store = readData();
  if (store.escrow && store.escrow.state === 'SHIPPED') {
    store.escrow.state = 'COMPLETED';
    store.escrow.funds = 0;
    writeData(store);
  }
  res.json({ escrow: store.escrow });
});

app.post('/api/escrow/dispute', (req, res) => {
  store = readData();
  if (store.escrow) {
    store.escrow.state = 'DISPUTED';
    writeData(store);
  }
  res.json({ escrow: store.escrow });
});

app.post('/api/reset', (req, res) => {
  store = readData();
  store.escrow = { state: 'IDLE', funds: 0 };
  writeData(store);
  res.json({ escrow: store.escrow });
});

// Serve static files (the prototype front-end)
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AgriLink prototype server running on http://localhost:${PORT}`);
});
