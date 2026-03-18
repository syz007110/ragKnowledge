const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
require('./queueProcessor');
console.log('[worker] ingest worker compatibility entry is running...');
