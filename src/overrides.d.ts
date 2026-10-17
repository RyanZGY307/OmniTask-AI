import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    query: Record<string, any>;
    params: Record<string, any>;
  }
}