// ───────────────────────────────────────────────────────────────────────────
// PHOENIX · LIVE AUTH RULE
//
// This is a REAL source file. The self-heal agent rewrites it in place when the
// login crashes. Ships in the BUGGY state so the demo breaks on the first click.
//
//   buggy : const role = user.account.role;   ← `account` was removed in a refactor
//   fixed : const role = user.role;           ← the field is now flat on `user`
// ───────────────────────────────────────────────────────────────────────────

export function authenticate(user, password) {
  if (!user || !password) {
    throw new Error('Missing credentials');
  }

  // Resolve the operator's access role for the session token.
  const role = user.role;                // PHOENIX-FIXED

  return {
    ok: true,
    user: user.name,
    role,
    token: `phx_${user.id}.${role}.${password.length}x`,
  };
}
