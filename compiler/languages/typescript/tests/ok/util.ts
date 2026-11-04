export interface Role {
  id: string;
  name: string;
  position: number;
}

export function topRoles(roles: Role[], n: number): string[] {
  return [...roles].sort((a, b) => b.position - a.position).slice(0, n).map((r) => r.name);
}
