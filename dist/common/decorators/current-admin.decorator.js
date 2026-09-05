"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CurrentAdmin = void 0;
const common_1 = require("@nestjs/common");
exports.CurrentAdmin = (0, common_1.createParamDecorator)((data, ctx) => {
    const request = ctx.switchToHttp().getRequest();
    const admin = request.admin;
    if (!admin) {
        return null;
    }
    return data ? admin[data] : admin;
});
