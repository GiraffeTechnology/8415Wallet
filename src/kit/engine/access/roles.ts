export type Role = 'ADMIN' | 'AUDITOR' | 'VIEWER';

export type Permission =
  | 'projection:read'
  | 'audit:read'
  | 'permissions:manage';

const GRANTS: Record<Role, readonly Permission[]> = {
  VIEWER: ['projection:read'],
  AUDITOR: ['projection:read', 'audit:read'],
  ADMIN: ['projection:read', 'audit:read', 'permissions:manage'],
};

export class AccessDenied extends Error {
  readonly permission: Permission;

  constructor(permission: Permission) {
    super(`missing permission: ${permission}`);
    this.name = 'AccessDenied';
    this.permission = permission;
  }
}

/**
 * Who may read what in the console.
 *
 * Reading is all these roles can do. No role here can admit an entry, open or
 * close a gap, or change a projection answer: the console has no write path
 * into the projection, so there is no permission that could grant one.
 */
export class Directory {
  readonly #roles = new Map<string, Role>();

  constructor(initial: Iterable<readonly [string, Role]> = []) {
    for (const [user, role] of initial) this.#roles.set(user.toLowerCase(), role);
  }

  roleOf(user: string): Role | undefined {
    return this.#roles.get(user.toLowerCase());
  }

  permissionsOf(user: string): readonly Permission[] {
    const role = this.roleOf(user);
    return role === undefined ? [] : GRANTS[role];
  }

  can(user: string, permission: Permission): boolean {
    return this.permissionsOf(user).includes(permission);
  }

  require(user: string, permission: Permission): void {
    if (!this.can(user, permission)) throw new AccessDenied(permission);
  }

  /** Only a holder of `permissions:manage` may change a role. */
  assign(actor: string, user: string, role: Role): void {
    this.require(actor, 'permissions:manage');
    this.#roles.set(user.toLowerCase(), role);
  }

  revoke(actor: string, user: string): void {
    this.require(actor, 'permissions:manage');
    this.#roles.delete(user.toLowerCase());
  }

  users(): readonly { user: string; role: Role }[] {
    return [...this.#roles.entries()]
      .map(([user, role]) => ({ user, role }))
      .sort((a, b) => a.user.localeCompare(b.user));
  }
}
