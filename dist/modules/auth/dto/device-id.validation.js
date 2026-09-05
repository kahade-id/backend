"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEVICE_ID_MESSAGE = exports.DEVICE_ID_PATTERN = void 0;
exports.normalizeDeviceId = normalizeDeviceId;
exports.DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,254}$/;
exports.DEVICE_ID_MESSAGE = 'Device identifier must be 8-255 characters using letters, digits, dots, underscores, colons, or hyphens';
function normalizeDeviceId(value) {
    return typeof value === 'string' ? value.trim() : value;
}
