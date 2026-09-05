"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Idempotency = exports.IDEMPOTENCY_KEY = void 0;
const common_1 = require("@nestjs/common");
exports.IDEMPOTENCY_KEY = 'idempotency';
const Idempotency = () => (0, common_1.SetMetadata)(exports.IDEMPOTENCY_KEY, true);
exports.Idempotency = Idempotency;
