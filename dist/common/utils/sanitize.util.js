"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.escapeHtml = escapeHtml;
const HTML_ESCAPE_MAP = {
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&#39;',
};
function escapeHtml(input) {
    return input.replace(/[<>&"']/g, (c) => HTML_ESCAPE_MAP[c] || c);
}
