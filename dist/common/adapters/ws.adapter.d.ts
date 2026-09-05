import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { INestApplication } from '@nestjs/common';
export declare class CorsIoAdapter extends IoAdapter {
    private readonly allowedOrigins;
    constructor(app: INestApplication, allowedOrigins: string[]);
    createIOServer(port: number, options?: Partial<ServerOptions>): unknown;
}
