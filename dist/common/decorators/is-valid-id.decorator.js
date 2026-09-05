"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IsValidId = IsValidId;
const class_validator_1 = require("class-validator");
const CUID_RE = /^c[a-z0-9]{24}$/;
const PREFIXED_ID_RE = /^[A-Z]{2,5}-[A-Za-z0-9_-]{3,80}$/;
const MAX_ID_LENGTH = 100;
function IsValidId(validationOptions) {
    return function (object, propertyName) {
        (0, class_validator_1.registerDecorator)({
            name: 'isValidId',
            target: object.constructor,
            propertyName,
            options: {
                message: `${propertyName} must be a valid ID`,
                ...validationOptions,
            },
            validator: {
                validate(value) {
                    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) {
                        return false;
                    }
                    return CUID_RE.test(value) || PREFIXED_ID_RE.test(value);
                },
            },
        });
    };
}
