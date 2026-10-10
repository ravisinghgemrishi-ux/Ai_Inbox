/**
 * Manual, offline verification of lib/formLead.js's parseFormLead() fix
 * (2026-10-11, audit follow-up). Run with: node test/formLead.manual-test.js
 *
 * Reproduces real DM text from the conversation audit (see the 2026-10-11
 * audit of 21 missed-phone conversations) to confirm the two bugs found
 * there are actually fixed:
 *   1. "First name:" was never captured (old regex only matched "Full name"
 *      or a key starting with "name").
 *   2. A lead that gives a different "WhatsApp number" and "Phone number"
 *      had one silently overwrite the other.
 */

const assert = require('assert');
const { isFormLead, parseFormLead } = require('../lib/formLead');

// --- Case 1: vidit_singh1 (2026-09-25) - "First name:" field -------------
{
  const text = [
    'Hello! I filled out your form and would like to know more about your business.',
    'What is your primary purpose?: Relationships',
    'What is your preferred budget?: Under ₹999',
    'Astrology consultation required?: No',
    'WhatsApp number: +919580001488',
    'First name: Vidit',
    'City: Siliguri',
    'Date of birth: 2000-06-15',
    'Phone number: 095800 01488',
  ].join('\n');

  assert.strictEqual(isFormLead(text), true, 'should be detected as a form lead');
  const lead = parseFormLead(text);
  assert.strictEqual(lead.name, 'Vidit', `expected name "Vidit", got "${lead.name}"`);
  assert.strictEqual(lead.city, 'Siliguri');
  assert.strictEqual(lead.purpose, 'Relationships');
  assert.strictEqual(lead.budget, 'Under ₹999');
  // WhatsApp number and Phone number are the same digits here -> no altPhone.
  assert.strictEqual(lead.phone, '+919580001488');
  assert.strictEqual(lead.altPhone, '', 'same number on both fields -> no altPhone');
  console.log('PASS: case 1 (First name field, matching WhatsApp/Phone)');
}

// --- Case 2: supriyo.paul.1044186 (2026-09-25) - two DIFFERENT numbers ---
{
  const text = [
    'Hello! I filled out your form and would like to know more about your business.',
    'What is your primary purpose?: Career & Success',
    'What is your preferred budget?: Under ₹999',
    'Astrology consultation required?: Yes',
    'WhatsApp number: +918336913157',
    'First name: Supriyo',
    'City: Howrah',
    'Date of birth: 1987-05-29',
    'Phone number: 098306 62177',
  ].join('\n');

  const lead = parseFormLead(text);
  assert.strictEqual(lead.name, 'Supriyo');
  // WhatsApp number must win as the primary phone (it's what the gemologist
  // calls and what the 7 PM check matches against staff WhatsApp activity).
  assert.strictEqual(lead.phone, '+918336913157', `expected WhatsApp number to win, got "${lead.phone}"`);
  // The other number must NOT be silently dropped.
  assert.strictEqual(lead.altPhone, '09830662177', `expected the differing Phone number to be kept as altPhone, got "${lead.altPhone}"`);
  console.log('PASS: case 2 (WhatsApp number wins, differing Phone number kept as altPhone)');
}

// --- Case 3: field order varies, "Full name" still works (regression) ---
{
  const text = [
    'Hello! I filled out your form and would like to know more about your business.',
    'Full name: Datta Bhagde',
    'Which Sapphire ?: Pitambari',
    'Average Budget ?: 20k-50k',
    'WhatsApp number: +917796138999',
    'City: Nashik',
  ].join('\n');

  const lead = parseFormLead(text);
  assert.strictEqual(lead.name, 'Datta Bhagde');
  assert.strictEqual(lead.phone, '+917796138999');
  assert.strictEqual(lead.requirement, 'Pitambari');
  assert.strictEqual(lead.budget, '20k-50k');
  assert.strictEqual(lead.city, 'Nashik');
  console.log('PASS: case 3 (existing "Full name" + single-number template still works)');
}

// --- Case 4: separate First name + Last name fields -----------------------
{
  const text = [
    'Hello! I filled out your form and would like to know more about your business.',
    'First name: Anjali',
    'Last name: Verma',
    'WhatsApp number: +919876543210',
  ].join('\n');

  const lead = parseFormLead(text);
  assert.strictEqual(lead.name, 'Anjali Verma', `expected combined first+last name, got "${lead.name}"`);
  console.log('PASS: case 4 (separate First name + Last name combine correctly)');
}

console.log('\nAll formLead.manual-test.js checks passed.');
