// Manual test: the Drive "Mannat Feed" tab parses into Rudraksha products. Run: node test/rudrakshaFeed.manual-test.js
const assert = require('assert');
const { _internal: { buildProducts, searchCatalog } } = require('../lib/productResolver');
const csv = [
  'Name,Mukhi,Origin,Shape,Selling Price,Compare-at Price,Availability,Product URL,Planet,Deity,Mantra,Benefits,Who Can Wear,Size (mm),On website',
  '5 Mukhi,5 Mukhi,Nepal,Round,1999,3000,Available,https://rudraksha.gemrishi.com/products/5-mukhi-rudraksha-nepal,Jupiter,Lord Kalagni,Om Hreem Namaha,Peace,Everyone,24mm,Yes',
  '7 Mukhi - Rare,7 Mukhi,Nepal,Round,9700,10700,Available,,Saturn,Goddess Maha Lakshmi,Om Hoom Namaha,Wealth,Anyone,23 mm,No - team to confirm',
  'Gauri Shankar,Gauri Shankar,Nepal,Double Lobed,13999,19400,Available,https://rudraksha.gemrishi.com/products/gauri-shankar-rudraksha-nepal,Moon,Shiva and Parvati,Om Gauri Shankaraye Namaha,Marriage harmony,Couples,33mm,Yes',
].join('\n');
const products = buildProducts(csv, { label: 'rudraksha' });
assert.strictEqual(products.length, 3);
assert.ok(products.every((p) => p.category === 'rudraksha'));
const five = products.find((p) => p.mukhi === 5);
assert.strictEqual(five.price_inr, 1999);
assert.strictEqual(five.mrp_inr, 3000);
assert.ok(five.url.endsWith('5-mukhi-rudraksha-nepal'));
assert.strictEqual(five.extra.Planet, 'Jupiter');
let r = searchCatalog(products, '5 mukhi rudraksha price');
assert.ok(r.found && r.products[0].name === '5 Mukhi', 'finds 5 Mukhi first');
r = searchCatalog(products, 'gauri shankar kitne ka hai');
assert.ok(r.found && r.products[0].name === 'Gauri Shankar', 'finds Gauri Shankar');
r = searchCatalog(products, 'मुझे 7 मुखी रुद्राक्ष चाहिए');
assert.ok(r.found && r.products.some((p) => p.name === '7 Mukhi - Rare'), 'Hindi 7 mukhi');
console.log('Rudraksha feed tests passed');
