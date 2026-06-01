import type { Request, Response, NextFunction } from 'express';
import basicAuth from 'basic-auth';
import { env } from '../env';

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!env.APP_AUTH_USER || !env.APP_AUTH_PASS) return next();

  const credentials = basicAuth(req);
  if (!credentials || credentials.name !== env.APP_AUTH_USER || credentials.pass !== env.APP_AUTH_PASS) {
    res.setHeader('WWW-Authenticate', 'Basic realm="maps-scraper"');
    res.status(401).send('Unauthorized');
    return;
  }
  next();
}
