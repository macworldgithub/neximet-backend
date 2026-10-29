const mongoose = require('mongoose');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const media = require('./chatMedia');

const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'chatAttachments' });

// Multer streams directly to GridFS so large batches never become message BSON
// documents or accumulate in server memory. Only a small signature is buffered.
const storage = {
  _handleFile(req, file, callback) {
    const store = bucket();
    const output = store.openUploadStream(file.originalname, { metadata: { conversation: req.params.id, sender: String(req.user._id) } });
    let size = 0, prefix = Buffer.alloc(0), detected, validationError;
    const inspect = new Transform({
      transform(chunk, encoding, done) {
        size += chunk.length;
        req.chatUploadBytes = (req.chatUploadBytes || 0) + chunk.length;
        if (req.chatUploadBytes > media.FILE_LIMIT) {
          // Drain this part before rejecting, so clients receive the validation
          // response instead of a reset connection while still uploading.
          validationError = Object.assign(new Error('Attachments must total 100 MB or smaller per message'), { status: 400 });
          return done();
        }
        if (prefix.length < 4096) prefix = Buffer.concat([prefix, chunk.subarray(0, 4096 - prefix.length)]);
        done(null, chunk);
      },
      flush(done) {
        if (validationError) return done(validationError);
        try {
          detected = media.attachment({ ...file, size, buffer: prefix });
          done();
        } catch (error) { done(error); }
      },
    });
    pipeline(file.stream, inspect, output).then(() => callback(null, {
      fileId: output.id, name: detected.name, size, mimeType: detected.mimeType,
    }), async error => {
      await store.delete(output.id).catch(() => {});
      callback(error);
    });
  },
  _removeFile(req, file, callback) {
    bucket().delete(file.fileId).then(() => callback(null), callback);
  },
};

async function discardUnused(files = []) {
  const Message = require('../models/Message');
  await Promise.all(files.map(async file => {
    if (!await Message.exists({ 'attachments.fileId': file.fileId })) await bucket().delete(file.fileId);
  }));
}

module.exports = { bucket, storage, discardUnused };
