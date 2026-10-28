const assert = require('assert');
const h = require('../lib/handoff');
const cases = [
  ['my budget is 20,000', 20000], ['budget 1 lakh', 100000], ['Rs 15000 tak', 15000],
  ['₹75k', 75000], ['2 lakh ke andar', 200000], ['5 ratti chahiye', 0], ['call me 9876543210', 0], ['7.25 carat', 0],
];
for (const [t, want] of cases) assert.strictEqual(h.parseBudget(h.budgetFromChat(t)), want, t);
console.log('budget-from-chat ok');
