const fs = require('node:fs');
const path = require('node:path');
module.exports = () => {
    const filename = path.join(__dirname, 'web', 'index.ejs');
    return require('ejs').render(fs.readFileSync(filename, 'utf8'), {}, {filename});
};
