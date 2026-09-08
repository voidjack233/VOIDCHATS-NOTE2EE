// server/utils/groupPermissions.js
// Centralized permission checking for group conversations.
//
// The `permissions` column on conversations is a JSONB object.
// When NULL (existing groups before migration), all defaults apply.

export type GroupRole = 'owner' | 'admin' | 'member' | 'viewer';
export type PermissionAudience = 'everyone' | 'admins' | 'owner';

export const PERMISSION_DEFAULTS = {
  admin_can_remove_members: true,
  admin_can_approve_join_requests: true,
  admin_can_edit_member_nicknames: true,
  admin_can_edit_group_profile: true,
  admin_can_manage_invite_links: true,
  members_can_set_own_nickname: true,
  who_can_send_attachments: 'everyone',
  who_can_create_invite_links: 'admins',
  who_can_approve_requests: 'admins',
  who_can_edit_other_nicknames: 'admins',
  who_can_edit_own_nickname: 'everyone',
  who_can_edit_group_profile: 'admins',
};

const VALID_WHO_VALUES: readonly PermissionAudience[] = ['everyone', 'admins', 'owner'];

/**
 * Merge stored permissions (possibly null) with defaults.
 */
export function resolvePermissions(stored: unknown): Record<string, unknown> {
  if (!stored || typeof stored !== 'object') return { ...PERMISSION_DEFAULTS };
  return { ...PERMISSION_DEFAULTS, ...stored };
}

/**
 * Validate a permissions object from user input.
 * Returns { valid: true, permissions } or { valid: false, error }.
 */
export function validatePermissions(input: unknown):
  | { valid: true; permissions: Record<string, unknown> }
  | { valid: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'permissions must be an object' };
  }

  const result: Record<string, unknown> = {};

  for (const [key, defaultValue] of Object.entries(PERMISSION_DEFAULTS)) {
    if (!(key in input)) continue;

    const value = Reflect.get(input, key);

    if (typeof defaultValue === 'boolean') {
      if (typeof value !== 'boolean') {
        return { valid: false, error: `${key} must be a boolean` };
      }
      result[key] = value;
    } else {
      if (typeof value !== 'string' || !VALID_WHO_VALUES.includes(
        value as PermissionAudience,
      )) {
        return { valid: false, error: `${key} must be one of: ${VALID_WHO_VALUES.join(', ')}` };
      }
      result[key] = value;
    }
  }

  // Reject unknown keys
  for (const key of Object.keys(input)) {
    if (!(key in PERMISSION_DEFAULTS)) {
      return { valid: false, error: `Unknown permission key: ${key}` };
    }
  }

  return { valid: true, permissions: result };
}

/**
 * Check if a role meets a "who can" threshold.
 * Owner always passes. The `who` value controls the minimum role.
 *
 *   'everyone' → owner, admin, member all pass
 *   'admins'   → owner, admin pass
 *   'owner'    → only owner passes
 */
export function meetsWhoThreshold(role: unknown, who: unknown): boolean {
  if (role === 'owner') return true;
  if (who === 'everyone') return role === 'member' || role === 'admin';
  if (who === 'admins') return role === 'admin';
  // who === 'owner'
  return false;
}

/**
 * Check if a role has an admin-toggle permission (boolean flags).
 * Owner always passes. Admin passes if the toggle is true.
 * Members/viewers never pass these (they are admin-specific toggles).
 */
export function meetsAdminToggle(role: unknown, toggleValue: unknown): boolean {
  if (role === 'owner') return true;
  if (role === 'admin') return toggleValue === true;
  return false;
}

const OPERATION_PERMISSIONS = {
  profile: ['who_can_edit_group_profile', 'admin_can_edit_group_profile'],
  otherNickname: ['who_can_edit_other_nicknames', 'admin_can_edit_member_nicknames'],
  ownNickname: ['who_can_edit_own_nickname', 'members_can_set_own_nickname'],
  invites: ['who_can_create_invite_links', 'admin_can_manage_invite_links'],
  approvals: ['who_can_approve_requests', 'admin_can_approve_join_requests'],
} as const;

export function canPerformGroupOperation(role: unknown, stored: unknown, operation: keyof typeof OPERATION_PERMISSIONS): boolean {
  const permissions = resolvePermissions(stored);
  const [audience, toggle] = OPERATION_PERMISSIONS[operation];
  if (!meetsWhoThreshold(role, permissions[audience])) return false;
  if (role === 'owner') return true;
  // Audience limits and role switches are both restrictions, never overrides.
  if (operation === 'invites' || operation === 'approvals') {
    return meetsAdminToggle(role, permissions[toggle]);
  }
  if (role === 'admin' || (operation === 'ownNickname' && role === 'member')) {
    return permissions[toggle] === true;
  }
  return true;
}
