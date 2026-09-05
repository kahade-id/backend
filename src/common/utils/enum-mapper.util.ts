import { ActorType, UserRole } from '@prisma/client';

export function userRoleToActorType(role: UserRole): ActorType {
  switch (role) {
    case UserRole.BUYER:
      return ActorType.BUYER;
    case UserRole.SELLER:
      return ActorType.SELLER;
    default:
      throw new Error(`Cannot map UserRole "${role}" to ActorType`);
  }
}

export function actorTypeToUserRole(actor: ActorType): UserRole {
  switch (actor) {
    case ActorType.BUYER:
      return UserRole.BUYER;
    case ActorType.SELLER:
      return UserRole.SELLER;
    default:
      throw new Error(`Cannot map ActorType "${actor}" to UserRole — only BUYER and SELLER are valid`);
  }
}

export function isUserActorType(actor: ActorType): boolean {
  return actor === ActorType.BUYER || actor === ActorType.SELLER;
}
