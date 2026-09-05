import { UserJwtPayload, AdminJwtPayload } from './jwt-payload.types';

declare global {
  namespace Express {
    interface Request {
      user?: UserJwtPayload;
      admin?: AdminJwtPayload;
      requestId?: string;
    }
  }
}
