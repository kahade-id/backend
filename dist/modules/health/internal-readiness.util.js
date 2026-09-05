"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isLoopbackInternalProbe = isLoopbackInternalProbe;
function isLoopbackInternalProbe(remoteAddress, headers) {
    const forwardedFor = headers['x-forwarded-for'];
    const hasForwardedChain = Array.isArray(forwardedFor)
        ? forwardedFor.some((value) => value.trim().length > 0)
        : typeof forwardedFor === 'string' && forwardedFor.trim().length > 0;
    if (hasForwardedChain)
        return false;
    return remoteAddress === '127.0.0.1'
        || remoteAddress === '::1'
        || remoteAddress === '::ffff:127.0.0.1';
}
