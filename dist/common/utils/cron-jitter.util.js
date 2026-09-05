"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cronJitter = cronJitter;
const crypto_1 = require("crypto");
function cronJitter(maxMs = 5_000) {
    const delay = (0, crypto_1.randomInt)(0, Math.max(1, maxMs));
    return new Promise((resolve) => setTimeout(resolve, delay));
}
