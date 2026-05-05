import mongoose from 'mongoose';
import { GridFSBucket, ObjectId } from 'mongodb';
import { StoredSession, deleteSessionAndFiles, getBucket, connectDB } from './src/db';
import { CONFIG } from './src/config';

CONFIG.MONGODB_URI = 'mongodb://localhost:27017/quickshare';

async function run() {
  await connectDB();
  const bucket = getBucket();
  
  // upload something
  const uploadStream = bucket.openUploadStream('test.txt');
  uploadStream.end(Buffer.from('hello world'));
  await new Promise(r => uploadStream.on('finish', r));
  const gridfsId = uploadStream.id as ObjectId;
  
  await StoredSession.create({
    code: '999999',
    text: 'test',
    files: [{
      name: 'test.txt',
      mimeType: 'text/plain',
      size: 11,
      gridfsId: gridfsId,
      token: '123'
    }],
    expiresAt: new Date(Date.now() + 1000)
  });
  
  console.log("Created session. Files in gridfs before delete:");
  console.log(await bucket.find({_id: gridfsId}).toArray());
  
  const chunksCollection = mongoose.connection.db!.collection('sharefiles.chunks');
  console.log("Chunks in gridfs before delete:", await chunksCollection.find({ files_id: gridfsId }).toArray());

  await deleteSessionAndFiles('999999');
  
  console.log("Files in gridfs after delete:");
  console.log(await bucket.find({_id: gridfsId}).toArray());
  
  console.log("Chunks in gridfs after delete:", await chunksCollection.find({ files_id: gridfsId }).toArray());
  process.exit(0);
}
run();
