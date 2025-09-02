// src/types/express-multer.d.ts
import 'express';

declare global {
  namespace Express {
    namespace Multer {
      interface File {
        // ya viene tipado por @types/multer,
        // esto es solo para asegurar presencia en Request
      }
    }
    interface Request {
      file?: Multer.File;
      files?: Multer.File[] | { [fieldname: string]: Multer.File[] };
    }
  }
}
