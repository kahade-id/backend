import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { INestApplication } from '@nestjs/common';

export class CorsIoAdapter extends IoAdapter {
  private readonly allowedOrigins: string[];

  constructor(app: INestApplication, allowedOrigins: string[]) {
    super(app);
    this.allowedOrigins = allowedOrigins;
  }

  createIOServer(port: number, options?: Partial<ServerOptions>): unknown {
    const opts: Partial<ServerOptions> = {
      ...options,
      maxHttpBufferSize: 1e6,
      cors: {
        origin: this.allowedOrigins,
        credentials: true,
      },
    };
    return super.createIOServer(port, opts);
  }
}
