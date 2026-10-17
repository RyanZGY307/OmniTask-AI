import multer from 'multer';
import path from 'path';

const storage = multer.memoryStorage();

export const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    const isZip = file.mimetype === 'application/zip' || name.endsWith('.zip');
    const isMd = file.mimetype === 'text/markdown' || name.endsWith('.md');
    if (isZip || isMd) {
      cb(null, true);
    } else {
      cb(new Error('只支持 ZIP 或单个 skill markdown (.md) 文件'));
    }
  },
});

export { multer as multerMiddleware };
