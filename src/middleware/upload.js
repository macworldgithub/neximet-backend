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
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB max file size (aligned with MongoDB 16MB doc limit)
  fileFilter,
});

module.exports = upload;
