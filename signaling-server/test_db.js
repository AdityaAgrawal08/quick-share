const mongoose = require('mongoose');
async function test() {
  await mongoose.connect('mongodb://localhost:27017/quick-share');
  const stats = await mongoose.connection.db.stats();
  console.log(stats);
  process.exit(0);
}
test();
