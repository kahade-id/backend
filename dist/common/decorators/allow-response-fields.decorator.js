"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AllowResponseFields = exports.ALLOW_RESPONSE_FIELDS_KEY = void 0;
const common_1 = require("@nestjs/common");
exports.ALLOW_RESPONSE_FIELDS_KEY = 'allowResponseFields';
const AllowResponseFields = (...fields) => (0, common_1.SetMetadata)(exports.ALLOW_RESPONSE_FIELDS_KEY, fields);
exports.AllowResponseFields = AllowResponseFields;
