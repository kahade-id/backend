"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.userRoleToActorType = userRoleToActorType;
exports.actorTypeToUserRole = actorTypeToUserRole;
exports.isUserActorType = isUserActorType;
const client_1 = require("@prisma/client");
function userRoleToActorType(role) {
    switch (role) {
        case client_1.UserRole.BUYER:
            return client_1.ActorType.BUYER;
        case client_1.UserRole.SELLER:
            return client_1.ActorType.SELLER;
        default:
            throw new Error(`Cannot map UserRole "${role}" to ActorType`);
    }
}
function actorTypeToUserRole(actor) {
    switch (actor) {
        case client_1.ActorType.BUYER:
            return client_1.UserRole.BUYER;
        case client_1.ActorType.SELLER:
            return client_1.UserRole.SELLER;
        default:
            throw new Error(`Cannot map ActorType "${actor}" to UserRole — only BUYER and SELLER are valid`);
    }
}
function isUserActorType(actor) {
    return actor === client_1.ActorType.BUYER || actor === client_1.ActorType.SELLER;
}
