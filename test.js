const line = '1 Dell Latitude 5450 Laptop Computer Equipment 2 72,500.00 18% 145,000.00';
const MONEY = '([0-9][0-9,]*\\.?[0-9]*)';
const regex = new RegExp(`^(.+?)\\s+(\\d{4,8})?\\s*(\\d+(?:\\.\\d+)?)\\s+${MONEY}(?:\\s+\\d{1,2}(?:\\.\\d+)?%)?(?:\\s+${MONEY})?$`);
console.log('Regex:', regex);
console.log('Match:', line.match(regex));
