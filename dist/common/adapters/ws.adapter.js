"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CorsIoAdapter = void 0;
const platform_socket_io_1 = require("@nestjs/platform-socket.io");
class CorsIoAdapter extends platform_socket_io_1.IoAdapter {
    constructor(app, allowedOrigins) {
        super(app);
        this.allowedOrigins = allowedOrigins;
    }
    createIOServer(port, options) {
        const opts = {
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
exports.CorsIoAdapter = CorsIoAdapter;
