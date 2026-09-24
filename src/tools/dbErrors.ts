/**
 * Shared classifier for "this id doesn't exist / isn't yours" vs. a real
 * fault. Used wherever a write or an RPC takes a caller-supplied id for a
 * row the RLS policy or a BEFORE INSERT/trigger might reject: the RLS
 * WITH CHECK rejects a foreign org (42501), an FK rejects an unknown id
 * (23503), or a PL/pgSQL RAISE (default SQLSTATE P0001, e.g. the
 * `set_organization_id_from_project()` trigger's "Projekt … existiert
 * nicht") rejects a missing parent. Only those three collapse into the
 * generic "not found" message; anything else (network blip, revoked grant,
 * misconfiguration, a real CHECK-constraint violation) is a genuine fault
 * and must surface with its own message, or debugging it becomes
 * guesswork.
 */
export function isNotFoundError(err: { code?: string }): boolean {
  return err.code === "42501" || err.code === "23503" || err.code === "P0001";
}
