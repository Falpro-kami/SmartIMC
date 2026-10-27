const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/_shared/access.js'));
for (const name of ['memberAccess', 'equipmentQuery', 'adminData', 'checkDatabase']) {
  const directory = path.join(__dirname, '../cloudfunctions', name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'access.js'), source);
}
console.log('Shared access policy synchronized.');
