'use strict';
/** GST state codes - the first two digits of a GSTIN identify the state. */
const STATES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  10: 'Bihar', 11: 'Sikkim', 12: 'Arunachal Pradesh', 13: 'Nagaland', 14: 'Manipur',
  15: 'Mizoram', 16: 'Tripura', 17: 'Meghalaya', 18: 'Assam', 19: 'West Bengal',
  20: 'Jharkhand', 21: 'Odisha', 22: 'Chhattisgarh', 23: 'Madhya Pradesh', 24: 'Gujarat',
  25: 'Daman and Diu', 26: 'Dadra and Nagar Haveli and Daman and Diu', 27: 'Maharashtra',
  29: 'Karnataka', 30: 'Goa', 31: 'Lakshadweep', 32: 'Kerala', 33: 'Tamil Nadu',
  34: 'Puducherry', 35: 'Andaman and Nicobar Islands', 36: 'Telangana', 37: 'Andhra Pradesh',
  38: 'Ladakh', 97: 'Other Territory', 99: 'Centre Jurisdiction',
};

const stateCode = (gstin) => String(gstin || '').trim().slice(0, 2);
const stateName = (code) => STATES[String(code || '').padStart(2, '0')] || '';

/** "Telangana(36)" as printed on the invoice; empty when the code is unknown. */
function placeOfSupply(code) {
  const clean = String(code || '').padStart(2, '0');
  const name = stateName(clean);
  return name ? `${name}(${clean})` : '';
}

module.exports = { STATES, stateCode, stateName, placeOfSupply };
