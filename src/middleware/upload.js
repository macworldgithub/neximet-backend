const multer = require('multer');
const path = require('path');

// Use memory storage for seamless Vercel serverless compatibility & DB persistence
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedExtensions = ['.pdf', '.doc', '.docx', '.txt', '.zip', '.png', '.jpg', '.jpeg'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only document files (PDF, DOC, DOCX, TXT, ZIP, Images) are allowed'));
  }
};

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5, fieldSize: 16000 }, // Base64 expands data before MongoDB's 16 MiB document limit.
  fileFilter,
});

module.exports = upload;
