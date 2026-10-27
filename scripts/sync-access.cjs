const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/_shared/access.js'));
for (const name of ['memberAccess', 'equipmentQuery', 'adminData', 'checkDatabase', 'weeklyReport', 'weeklyPublish']) {
  const directory = path.join(__dirname, '../cloudfunctions', name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'access.js'), source);
}
fs.copyFileSync(path.join(__dirname, '../cloudfunctions/weeklyReport/publisher.js'), path.join(__dirname, '../cloudfunctions/weeklyPublish/publisher.js'));
console.log('Shared access policy synchronized.');
