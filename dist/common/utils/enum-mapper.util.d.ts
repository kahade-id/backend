import { ActorType, UserRole } from '@prisma/client';
export declare function userRoleToActorType(role: UserRole): ActorType;
export declare function actorTypeToUserRole(actor: ActorType): UserRole;
export declare function isUserActorType(actor: ActorType): boolean;
