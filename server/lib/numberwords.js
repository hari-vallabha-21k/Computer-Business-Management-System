'use strict';
/** Amount in words, Indian numbering (crore / lakh / thousand), as printed on invoices. */

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n) {
  if (n < 20) return ONES[n];
  const tens = TENS[Math.floor(n / 10)];
  const rest = n % 10;
  return rest ? `${tens} ${ONES[rest]}` : tens;
}

function threeDigits(n) {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts = [];
  if (hundreds) parts.push(`${ONES[hundreds]} Hundred`);
  if (rest) parts.push(twoDigits(rest));
  return parts.join(' ');
}

/** 113000 -> "One Lakh Thirteen Thousand". Returns '' for 0. */
function inWords(value) {
  let n = Math.floor(Math.abs(Number(value) || 0));
  if (!n) return '';
  const groups = [];
  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  const lakh = Math.floor(n / 100000);
  n %= 100000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) groups.push(`${inWords(crore)} Crore`);
  if (lakh) groups.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) groups.push(`${twoDigits(thousand)} Thousand`);
  if (n) groups.push(threeDigits(n));
  return groups.join(' ');
}

/**
 * Full invoice wording: "Rupees One Lakh Thirteen Thousand Only",
 * with paise spelled out when the amount is not whole.
 */
function rupeesInWords(amount, currency = 'Rupees') {
  const value = Number(amount) || 0;
  const whole = Math.floor(Math.abs(value));
  const paise = Math.round((Math.abs(value) - whole) * 100);
  const parts = [];
  if (value < 0) parts.push('Minus');
  parts.push(currency);
  parts.push(whole ? inWords(whole) : 'Zero');
  if (paise) parts.push(`and ${twoDigits(paise)} Paise`);
  parts.push('Only');
  return parts.join(' ');
}

module.exports = { inWords, rupeesInWords };
